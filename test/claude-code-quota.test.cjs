const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

// Everything is synthetic: no real credential file or network is ever touched.
const USAGE = "https://api.anthropic.com/api/oauth/usage";
const WHAM = "https://chatgpt.com/backend-api/wham/usage";
const CC_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const CC_TOKEN = "synthetic-claude-code-token";
const NATIVE_TOKEN = "synthetic-native-token";
const CODEX_TOKEN = `h.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  }),
).toString("base64url")}.s`;
const tick = () => new Promise((done) => setImmediate(done));
const text = (entry) => JSON.stringify(entry.panel);
const panel = (env) =>
  env.registrations
    .filter((item) => item.panel.id === "subscription:claude-code")
    .at(-1);

const credentials = (oauth = { accessToken: CC_TOKEN }) =>
  JSON.stringify({ claudeAiOauth: oauth });
const fileInfo = (over = {}) => ({
  isFile: () => true,
  size: 100,
  mode: 0o100600,
  ...over,
});
const usageBody = (over = {}) => ({
  five_hour: { utilization: 20, resets_at: "2026-01-01T15:00:00Z" },
  seven_day: { utilization: 35, resets_at: "2026-01-05T00:00:00Z" },
  ...over,
});

function start(options = {}) {
  const reads = [];
  const calls = [];
  const state = {
    file: "file" in options ? options.file : credentials(),
    info: options.info ?? fileInfo(),
    claude: options.claude ?? (async () => Response.json(usageBody())),
  };
  const runtime = loadRuntime({
    expose: "",
    lstat: async (target) => {
      reads.push(["lstat", target]);
      if (state.file === undefined)
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return state.info;
    },
    readFile: async (target) => {
      reads.push(["read", target]);
      if (target === CC_PATH && state.file !== undefined) return state.file;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetch: async (url, init) => {
      const auth = init.headers.Authorization;
      calls.push({ url, init, auth });
      if (url === WHAM)
        return Response.json({
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000 },
          },
        });
      return auth === `Bearer ${CC_TOKEN}`
        ? state.claude(url, init)
        : Response.json({ five_hour: { utilization: 10, resets_at: null } });
    },
  });
  const handlers = {};
  const commands = {};
  runtime.entry.default({
    on: (event, handler) => (handlers[event] = handler),
    registerCommand: (name, command) => (commands[name] = command),
  });
  const notices = [];
  const asked = [];
  const ctx = {
    mode: "tui",
    model: { provider: "openai" },
    ui: { notify: (message) => notices.push(message) },
    modelRegistry: {
      getProviderAuth: async (provider) => {
        asked.push(provider);
        return {
          source: "OAuth",
          auth: {
            apiKey: provider === "anthropic" ? NATIVE_TOKEN : CODEX_TOKEN,
          },
        };
      },
    },
  };
  const advance = async (ms) => {
    runtime.env.now += ms;
    runtime.env.intervals.at(-1).fn();
    await tick();
  };
  const own = () => calls.filter((c) => c.auth === `Bearer ${CC_TOKEN}`);
  return {
    ...runtime,
    state,
    reads,
    calls,
    own,
    handlers,
    commands,
    ctx,
    notices,
    asked,
    advance,
  };
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

test("startup makes one bounded read of the exact Claude Code file", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.equal(h.own().length, 1);
  const [call] = h.own();
  assert.equal(call.url, USAGE);
  assert.equal(call.init.redirect, "error");
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(
    { ...call.init.headers },
    {
      Authorization: `Bearer ${CC_TOKEN}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    },
  );
  const shown = text(panel(h.env));
  assert.match(shown, /80% left/);
  assert.match(shown, /65% left/);
  assert.doesNotMatch(shown, new RegExp(CC_TOKEN));
  // Only that file is read for this provider; no other store, no OpenCode/Pi.
  assert.ok(h.reads.some(([op, p]) => op === "read" && p === CC_PATH));
  assert.ok(
    h.reads
      .filter(([, p]) => /credentials|auth/i.test(p))
      .every(([, p]) => p === CC_PATH),
  );
  assert.deepEqual(h.asked.sort(), ["anthropic", "openai-codex"]);
});

test("native Anthropic keeps its own credential and Claude Code never uses it", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const usage = h.calls.filter((c) => c.url === USAGE);
  assert.deepEqual(usage.map((c) => c.auth).sort(), [
    `Bearer ${CC_TOKEN}`,
    `Bearer ${NATIVE_TOKEN}`,
  ]);
  const native = usage.find((c) => c.auth === `Bearer ${NATIVE_TOKEN}`);
  assert.equal(native.init.headers["anthropic-version"], "2023-06-01");
});

test("a valid partial response shows only the reported window", async () => {
  const h = start({
    claude: async () =>
      Response.json({ five_hour: null, seven_day: usageBody().seven_day }),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const shown = text(panel(h.env));
  assert.match(shown, /65% left/);
  assert.doesNotMatch(shown, /80% left/);
});

test("missing, expired, insecure or malformed credentials make no request", async () => {
  const cases = [
    { file: undefined },
    { file: credentials({ accessToken: CC_TOKEN, expiresAt: 1 }) },
    {
      file: credentials({ accessToken: CC_TOKEN }),
      info: fileInfo({ mode: 0o100644 }),
    },
    {
      file: credentials({ accessToken: CC_TOKEN }),
      info: fileInfo({ isFile: () => false }),
    },
    {
      file: credentials({ accessToken: CC_TOKEN }),
      info: fileInfo({ size: 10_000_000 }),
    },
    { file: credentials({ accessToken: "bad token\r\nx: y" }) },
    { file: "not json" },
    { file: JSON.stringify({ other: {} }) },
  ];
  for (const options of cases) {
    const h = start(options);
    await h.handlers.session_start({}, h.ctx);
    await tick();
    assert.equal(h.own().length, 0);
    assert.match(text(panel(h.env)), /sin sesión de Claude Code/);
  }
});

test("429 waits at least five minutes and honors a longer Retry-After", async () => {
  let limited = true;
  const h = start({
    claude: async () =>
      limited
        ? new Response("secret-body", {
            status: 429,
            headers: { "retry-after": "3600" },
          })
        : Response.json(usageBody()),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.match(text(panel(h.env)), /HTTP 429/);
  assert.doesNotMatch(text(panel(h.env)), /secret-body/);
  await h.advance(59 * 60_000);
  assert.equal(h.own().length, 1);
  limited = false;
  await h.advance(2 * 60_000);
  assert.equal(h.own().length, 2);
  assert.match(text(panel(h.env)), /80% left/);
});

test("429 without Retry-After still waits the five-minute minimum", async () => {
  const h = start({ claude: async () => new Response("", { status: 429 }) });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.advance(4 * 60_000);
  assert.equal(h.own().length, 1);
  await h.advance(2 * 60_000);
  assert.equal(h.own().length, 2);
});

test("401 blocks automatic reads and guides to the supported retry command", async () => {
  const h = start({ claude: async () => new Response("", { status: 401 }) });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.match(text(panel(h.env)), /HTTP 401/);
  assert.match(text(panel(h.env)), /subscriptions retry claude-code/);
  assert.doesNotMatch(text(panel(h.env)), /until restart/);
  await h.advance(3_600_000);
  assert.equal(h.own().length, 1);
  await h.commands.subscriptions.handler("retry claude-code", h.ctx);
  await tick();
  assert.equal(h.own().length, 2);
});

test("reads happen once at startup, then only after five minutes", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  for (let i = 0; i < 4; i++) await h.advance(60_000);
  assert.equal(h.own().length, 1);
  await h.advance(61_000);
  assert.equal(h.own().length, 2);
});

test("a reload inside the gap does not read again", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.advance(60_000);
  assert.equal(h.own().length, 1);
});

test("an ordinary Claude response updates the panel and defers the next read", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  await h.advance(4 * 60_000);
  h.handlers.message_end(claudeEvent(0.5, h.env.now));
  assert.match(text(panel(h.env)), /50% left/);
  await h.advance(4 * 60_000);
  assert.equal(h.own().length, 1);
  await h.advance(61_000);
  assert.equal(h.own().length, 2);
});

test("a response arriving during a read wins over its late data", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const h = start({
    claude: async () => {
      await gate;
      return Response.json(usageBody());
    },
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  h.env.now += 1000;
  h.handlers.message_end(claudeEvent(0.5, h.env.now));
  release();
  await tick();
  await tick();
  const shown = text(panel(h.env));
  assert.match(shown, /50% left/);
  assert.doesNotMatch(shown, /80% left/);
});

test("a message without quota diagnostics neither defers nor drops a read", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  h.handlers.message_end({
    message: { role: "assistant", provider: "claude-code" },
  });
  await h.advance(301_000);
  assert.equal(h.own().length, 2);
});

test("shutdown aborts the read and its late result never publishes", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const h = start({
    claude: async () => {
      await gate;
      return Response.json(usageBody());
    },
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const signal = h.own()[0].init.signal;
  assert.equal(signal.aborted, false);
  h.handlers.session_shutdown();
  assert.equal(signal.aborted, true);
  const updates = h.env.registrations.map((item) => item.updates);
  release();
  await tick();
  await tick();
  assert.deepEqual(
    h.env.registrations.map((item) => item.updates),
    updates,
  );
});

test("an oversized body fails safely without showing its content", async () => {
  const h = start({
    claude: async () =>
      new Response(`${"x".repeat(70_000)}secret-tail`, { status: 200 }),
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const shown = text(panel(h.env));
  assert.match(shown, /error de consulta/);
  assert.doesNotMatch(shown, /secret/);
});

test("network errors are labelled without raw error text", async () => {
  const h = start({
    claude: async () => {
      throw new TypeError(`fetch failed for ${CC_TOKEN}`);
    },
  });
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const shown = text(panel(h.env));
  assert.match(shown, /error de red/);
  assert.doesNotMatch(shown, new RegExp(CC_TOKEN));
});

test("non-TUI sessions never read the Claude Code file", async () => {
  const h = start();
  await h.handlers.session_start({}, { ...h.ctx, mode: "rpc" });
  await tick();
  assert.equal(h.reads.length, 0);
  assert.equal(h.calls.length, 0);
});
