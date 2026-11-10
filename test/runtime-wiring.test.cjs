const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

const WHAM = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC = "https://api.anthropic.com/api/oauth/usage";
// Synthetic unsigned token carrying a fictional account claim.
const TOKEN = `h.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  }),
).toString("base64url")}.s`;
const tick = () => new Promise((done) => setImmediate(done));
const text = (entry) => JSON.stringify(entry.panel);

function start(options = {}) {
  const runtime = loadRuntime({
    fetch: options.fetch ?? defaultFetch,
    readFile: options.readFile,
    expose: "",
  });
  const handlers = {};
  const commands = {};
  const allowed = { on: (e, h) => (handlers[e] = h), registerCommand };
  function registerCommand(name, command) {
    commands[name] = command;
  }
  // Any model, provider or auth registration would throw.
  const pi = new Proxy(allowed, {
    get(target, key) {
      if (key in target) return target[key];
      throw new Error(`Unexpected pi.${String(key)}`);
    },
  });
  runtime.entry.default(pi);
  const asked = [];
  const notices = [];
  const ctx = {
    mode: options.mode ?? "tui",
    model: { provider: "openai" },
    ui: { notify: (message) => notices.push(message) },
    modelRegistry: {
      getProviderAuth: async (provider) => {
        asked.push(provider);
        return { source: "OAuth", auth: { apiKey: TOKEN } };
      },
    },
  };
  return { ...runtime, handlers, commands, ctx, asked, notices };
}

async function defaultFetch(url) {
  return url === WHAM
    ? Response.json({
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
        },
      })
    : Response.json({ five_hour: { utilization: 10, resets_at: null } });
}

const claudeEvent = (utilization, timestamp) => ({
  message: {
    role: "assistant",
    provider: "claude-code",
    diagnostics: [
      {
        type: "claude-code.rate-limit",
        timestamp,
        details: {
          unifiedWindows: { five_hour: { utilization, resetsAt: 1767290000 } },
        },
      },
    ],
  },
});
const panel = (env, id) =>
  env.registrations.filter((item) => item.panel.id === id).at(-1);

test("a TUI start registers four panels and reads only Codex and native Anthropic", async () => {
  const { env, handlers, ctx, asked } = start();
  await handlers.session_start({}, ctx);
  await tick();
  assert.deepEqual(
    env.registrations.map((item) => item.panel.id),
    [
      "subscription:limits",
      "subscription:claude-code",
      "subscription:antigravity",
      "subscription:anthropic",
    ],
  );
  assert.deepEqual(env.requests.sort(), [ANTHROPIC, WHAM]);
  assert.deepEqual(asked.sort(), ["anthropic", "openai-codex"]);
  assert.match(text(panel(env, "subscription:limits")), /75/);
  assert.match(text(panel(env, "subscription:anthropic")), /90/);
  assert.equal(env.intervals.length, 1);
  assert.deepEqual(env.fileCalls, ["read"]);
});

test("non-TUI sessions make no request and register nothing", async () => {
  const { env, handlers, ctx } = start({ mode: "rpc" });
  await handlers.session_start({}, ctx);
  await tick();
  handlers.after_provider_response(
    { status: 200, headers: { "x-codex-primary-used-percent": "10" } },
    ctx,
  );
  assert.deepEqual(env.requests, []);
  assert.equal(env.registrations.length, 0);
  assert.equal(env.intervals.length, 0);
});

test("Claude responses, toggles and the local tick never query Claude Code", async () => {
  const { env, handlers, commands, ctx } = start();
  await handlers.session_start({}, ctx);
  await tick();
  const before = env.requests.length;
  const claude = panel(env, "subscription:claude-code");
  assert.equal(handlers.message_end(claudeEvent(0.3, env.now)), undefined);
  assert.match(text(claude), /70/);
  const updates = claude.updates;
  await commands.subscriptions.handler("toggle codex", ctx);
  await commands.subscriptions.handler("display used", ctx);
  await tick();
  assert.match(text(panel(env, "subscription:limits")), /1w 40% used/);
  assert.equal(env.requests.length, before);
  assert.ok(env.fileCalls.includes("rename"));
  assert.ok(env.registrations.every((item) => item.disposed === 0));
  // One minute later only the 60s Codex baseline is due; the tick still renders.
  env.now += 61_000;
  env.intervals[0].fn();
  await tick();
  assert.deepEqual(env.requests.slice(before), [WHAM]);
  assert.ok(claude.updates > updates);
});

test("response headers update quota without another request and keep other windows", async () => {
  const { env, handlers, ctx } = start();
  await handlers.session_start({}, ctx);
  await tick();
  const before = env.requests.length;
  env.now += 30_000;
  handlers.after_provider_response(
    {
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "88",
        "x-codex-primary-window-minutes": "10080",
      },
    },
    ctx,
  );
  const codex = text(panel(env, "subscription:limits"));
  assert.match(codex, /12/);
  assert.match(codex, /75/);
  assert.equal(env.requests.length, before);
});

test("diagnostics, shutdown and reload leave no late updates", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { env, handlers, commands, ctx, notices } = start({
    fetch: async (url) => {
      await gate;
      return defaultFetch(url);
    },
  });
  await handlers.session_start({}, ctx);
  await commands["subscription-debug"].handler("", ctx);
  handlers.after_provider_response(
    { status: 200, headers: { "x-ratelimit-reset": "synthetic" } },
    ctx,
  );
  assert.match(notices.at(-1), /x-ratelimit-reset/);
  await handlers.session_start({}, ctx);
  assert.ok(env.registrations.slice(0, 4).every((item) => item.disposed === 1));
  assert.ok(env.intervals[0].cleared);
  handlers.session_shutdown();
  assert.ok(env.intervals.every((timer) => timer.cleared));
  assert.ok(env.registrations.every((item) => item.disposed === 1));
  const updates = env.registrations.map((item) => item.updates);
  release();
  await tick();
  await tick();
  assert.deepEqual(
    env.registrations.map((item) => item.updates),
    updates,
  );
});

test("headers received while preferences load are retained and the poll schedule is honored", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { env, handlers, ctx } = start({
    readFile: async () => {
      await gate;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  const starting = handlers.session_start({}, ctx);
  await tick();
  assert.equal(env.registrations.length, 0);
  // Only the weekly window is reported, as a partial passive update.
  handlers.after_provider_response(
    {
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "88",
        "x-codex-primary-window-minutes": "10080",
      },
    },
    ctx,
  );
  release();
  await starting;
  await tick();
  const codex = text(panel(env, "subscription:limits"));
  assert.match(codex, /12/);
  assert.doesNotMatch(codex, /75/);
  // The header reset the Codex schedule; only Anthropic is polled at start.
  assert.deepEqual(env.requests, [ANTHROPIC]);
  env.now += 61_000;
  env.intervals[0].fn();
  await tick();
  assert.deepEqual(env.requests, [ANTHROPIC, WHAM]);
});
