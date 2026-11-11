const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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
const panel = (env, id) =>
  env.registrations.filter((item) => item.panel.id === id).at(-1);
const USAGE_JSON = JSON.stringify({
  command: {
    name: "usage",
    data: {
      groups: [
        { id: "g", buckets: [{ window: "weekly", remaining_fraction: 0.5 }] },
      ],
    },
  },
});

const okFetch = async (url) =>
  url === WHAM
    ? Response.json({
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18000 },
        },
      })
    : Response.json({ five_hour: { utilization: 10, resets_at: null } });

// A fake `spawn`; the real Antigravity CLI can never run in these tests.
function fakeSpawn() {
  const children = [];
  const spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.pid = 4242;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    children.push({ binary, args, options, child });
    return child;
  };
  return { spawn, children };
}
const finish = (child, output = USAGE_JSON, code = 0) => {
  child.stdout.emit("data", Buffer.from(output));
  child.emit("exit", code, null);
  child.emit("close", code, null);
};

function start(options = {}) {
  const spawner = fakeSpawn();
  const runtime = loadRuntime({
    fetch: options.fetch ?? okFetch,
    spawn: spawner.spawn,
    expose: "",
  });
  const handlers = {};
  const commands = {};
  runtime.entry.default({
    on: (event, handler) => (handlers[event] = handler),
    registerCommand: (name, command) => (commands[name] = command),
  });
  const notices = [];
  const ctx = {
    mode: "tui",
    model: { provider: options.provider ?? "openai" },
    ui: { notify: (message) => notices.push(message) },
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: { apiKey: TOKEN },
      }),
    },
  };
  const advance = async (ms) => {
    runtime.env.now += ms;
    runtime.env.intervals.at(-1).fn();
    await tick();
  };
  const command = (args) => commands.subscriptions.handler(args, ctx);
  const count = (url) => runtime.env.requests.filter((u) => u === url).length;
  return {
    ...runtime,
    ...spawner,
    handlers,
    ctx,
    notices,
    advance,
    command,
    count,
  };
}

test("Antigravity is off by default: no spawn on start, ticks or activity", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.advance(3_600_000);
  h.handlers.after_provider_response({ status: 200, headers: {} }, h.ctx);
  await h.advance(3_600_000);
  assert.equal(h.children.length, 0);
});

test("opting in reads nothing by itself; the next tick spawns one bounded CLI read", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh antigravity on");
  assert.equal(h.children.length, 0);
  assert.match(
    text(panel(h.env, "subscription:antigravity")),
    /Awaiting refresh/,
  );
  await tick();
  assert.ok(h.env.fileCalls.includes("rename"));
  await h.advance(61_000);
  assert.equal(h.children.length, 1);
  assert.deepEqual(Array.from(h.children[0].args), [
    "--print",
    "/usage",
    "--output-format",
    "json",
    "--print-timeout",
    "30s",
  ]);
  assert.equal(h.children[0].options.shell, false);
  finish(h.children[0].child);
  await tick();
  assert.match(text(panel(h.env, "subscription:antigravity")), /50/);
  // Not due again inside the idle minimum, however many ticks pass.
  await h.advance(61_000);
  assert.equal(h.children.length, 1);
});

test("an indeterminate CLI failure pauses automation; manual retry honors the minimum gap", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh antigravity on");
  await h.advance(61_000);
  finish(h.children[0].child, "garbage", 1);
  await tick();
  assert.match(text(panel(h.env, "subscription:antigravity")), /manual retry/);
  await h.advance(3 * 3_600_000);
  assert.equal(h.children.length, 1);
  await h.command("retry antigravity");
  assert.match(h.notices.at(-1), /refresh started/);
  assert.equal(h.children.length, 2);
});

test("turning Antigravity off kills only its own child and drops the late result", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh antigravity on");
  await h.advance(61_000);
  const { child } = h.children[0];
  const before = text(panel(h.env, "subscription:antigravity"));
  await h.command("refresh antigravity off");
  assert.match(text(panel(h.env, "subscription:antigravity")), /disabled/);
  await tick();
  assert.deepEqual(child.signals, ["SIGKILL"]);
  finish(child);
  await tick();
  assert.doesNotMatch(text(panel(h.env, "subscription:antigravity")), /50/);
  assert.notEqual(before, "");
  assert.equal(h.children.length, 1);
});

test("429 with Retry-After blocks every read until its deadline", async () => {
  let limited = true;
  const h = start({
    fetch: async (url) =>
      limited && url === WHAM
        ? new Response("", { status: 429, headers: { "retry-after": "3600" } })
        : okFetch(url),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.match(text(panel(h.env, "subscription:limits")), /HTTP 429/);
  await h.advance(59 * 60_000);
  assert.equal(h.count(WHAM), 1);
  limited = false;
  await h.advance(2 * 60_000);
  assert.equal(h.count(WHAM), 2);
  assert.match(text(panel(h.env, "subscription:limits")), /75/);
});

test("401 stops automatic reads; explicit retry respects the gap and makes one read", async () => {
  let rejected = true;
  const h = start({
    fetch: async (url) =>
      rejected && url === WHAM
        ? new Response("", { status: 401 })
        : okFetch(url),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.match(text(panel(h.env, "subscription:limits")), /manual retry/);
  await h.advance(3_600_000);
  assert.equal(h.count(WHAM), 1);
  rejected = false;
  await h.command("retry codex");
  await tick();
  assert.equal(h.count(WHAM), 2);
  assert.match(text(panel(h.env, "subscription:limits")), /75/);
});

test("an immediate retry is deferred with a message and no request", async () => {
  const h = start({
    fetch: async (url) =>
      url === WHAM ? new Response("", { status: 403 }) : okFetch(url),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const before = h.env.requests.length;
  await h.command("retry codex");
  assert.match(h.notices.at(-1), /Codex: retry deferred until/);
  assert.equal(h.env.requests.length, before);
  // The scheduler keeps the deferred retry: it runs at the first eligible tick.
  await h.advance(30_000);
  assert.equal(h.env.requests.length, before);
  await h.advance(31_000);
  assert.equal(h.count(WHAM), 2);
});

test("an Antigravity retry deferred by the idle minimum makes no spawn until due", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh antigravity on");
  await h.advance(61_000);
  finish(h.children[0].child, "garbage", 1);
  await tick();
  h.env.now += 10_000;
  await h.command("retry antigravity");
  assert.match(h.notices.at(-1), /deferred until .* UTC.*no request was made/);
  await h.advance(600_000);
  assert.equal(h.children.length, 1);
  await h.advance(600_000);
  assert.equal(h.children.length, 2);
});

test("Claude Code retry is deferred by the gap and responses never cause a request", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const before = h.env.requests.length;
  await h.command("retry claude-code");
  assert.doesNotMatch(h.notices.at(-1), /never queried/);
  h.handlers.message_end({
    message: { role: "assistant", provider: "claude-code" },
  });
  await h.advance(61_000);
  assert.equal(h.env.requests.filter((url) => url === ANTHROPIC).length, 1);
  assert.equal(h.env.requests.length, before + 1);
});

test("collapsed refresh is a separate setting; toggling never reads", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh collapsed off");
  await h.command("toggle codex");
  await h.advance(120_000);
  assert.equal(h.count(WHAM), 1);
  const before = h.env.requests.length;
  await h.command("toggle codex");
  assert.equal(h.env.requests.length, before);
  await h.advance(1_000);
  assert.equal(h.count(WHAM), 2);
  // Display-only collapse with the default setting keeps refreshing.
  await h.command("refresh collapsed on");
  await h.command("toggle codex");
  await h.advance(61_000);
  assert.equal(h.count(WHAM), 3);
});

test("ordinary provider responses are activity only and never request quota", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const before = h.env.requests.length;
  for (const provider of ["openai", "openai-codex", "anthropic", "other"]) {
    h.handlers.after_provider_response(
      { status: 200, headers: {} },
      { ...h.ctx, model: { provider } },
    );
  }
  assert.equal(h.env.requests.length, before);
});

test("shutdown aborts supported HTTP reads and late results never publish", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const signals = [];
  const h = start({
    fetch: async (url, options) => {
      signals.push(options.signal);
      await gate;
      return okFetch(url);
    },
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => !signal.aborted));
  h.handlers.session_shutdown();
  assert.ok(signals.every((signal) => signal.aborted));
  const updates = h.env.registrations.map((item) => item.updates);
  release();
  await tick();
  await tick();
  assert.deepEqual(
    h.env.registrations.map((item) => item.updates),
    updates,
  );
});

test("a reload while a read is in flight does not start a duplicate request", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const h = start({
    fetch: async (url) => {
      await gate;
      return okFetch(url);
    },
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.equal(h.env.requests.length, 2);
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.advance(3_600_000);
  assert.equal(h.env.requests.length, 2);
  release();
  await tick();
  await h.advance(61_000);
  assert.equal(h.count(WHAM), 2);
});

test("Antigravity provider responses switch it to the active gap without an immediate read", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh antigravity on");
  await h.advance(61_000);
  finish(h.children[0].child);
  await tick();
  h.handlers.after_provider_response(
    { status: 200, headers: {} },
    { ...h.ctx, model: { provider: "antigravity" } },
  );
  assert.equal(h.children.length, 1);
  await h.advance(61_000);
  assert.equal(h.children.length, 1);
  await h.advance(130_000);
  assert.equal(h.children.length, 2);
});

test("without Antigravity activity the idle gap still applies", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.command("refresh antigravity on");
  await h.advance(61_000);
  finish(h.children[0].child);
  await tick();
  await h.advance(200_000);
  assert.equal(h.children.length, 1);
});

test("stop/reload during a pending body cleanup still honors the known Retry-After", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  let limited = true;
  const h = start({
    fetch: async (url) => {
      if (url !== WHAM) return okFetch(url);
      if (!limited) return okFetch(url);
      await gate;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "3600" }),
        body: { cancel: () => Promise.reject(new Error("cleanup failed")) },
      };
    },
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  h.handlers.session_shutdown();
  release();
  await tick();
  await tick();
  limited = false;
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.advance(59 * 60_000);
  assert.equal(h.count(WHAM), 1);
  await h.advance(2 * 60_000);
  assert.equal(h.count(WHAM), 2);
});

test("a passive response after a surfaced block keeps the guidance beside the new windows", async () => {
  const h = start({
    fetch: async (url) =>
      url === WHAM ? new Response("", { status: 401 }) : okFetch(url),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.match(text(panel(h.env, "subscription:limits")), /manual retry/);
  const before = h.env.requests.length;
  h.handlers.after_provider_response(
    {
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "37",
        "x-codex-primary-window-minutes": "300",
      },
    },
    h.ctx,
  );
  await tick();
  const shown = text(panel(h.env, "subscription:limits"));
  // The panel truncates the long state line, so match the visible prefix.
  assert.match(shown, /manual retry: \/subscriptions retry/);
  assert.match(shown, /Last read failed: HTTP 401/);
  assert.match(shown, /63% left/);
  assert.equal(h.env.requests.length, before);
  await h.advance(3_600_000);
  assert.equal(h.count(WHAM), 1);
});

test("a reload after an authentication block surfaces it without querying or restoring quota", async () => {
  const h = start({
    fetch: async (url) =>
      url === WHAM ? new Response("", { status: 401 }) : okFetch(url),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const before = h.env.requests.length;
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const shown = text(panel(h.env, "subscription:limits"));
  assert.match(shown, /manual retry: \/subscriptions retry/);
  assert.match(shown, /Last read failed: HTTP 401/);
  assert.doesNotMatch(shown, /75/);
  assert.equal(h.env.requests.length, before);
});
