const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

// Synthetic only: no real credential file, network or Pi session is touched.
const USAGE = "https://api.anthropic.com/api/oauth/usage";
const WHAM = "https://chatgpt.com/backend-api/wham/usage";
const CC_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const CC_TOKEN = "synthetic-claude-code-token";
const CODEX_TOKEN = `h.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  }),
).toString("base64url")}.s`;
const tick = () => new Promise((done) => setImmediate(done));
const text = (entry) => JSON.stringify(entry.panel);
const panel = (env, id) =>
  env.registrations.filter((item) => item.panel.id === id).at(-1);

function start(provider = "openai") {
  const runtime = loadRuntime({
    expose: "",
    lstat: async () => ({ isFile: () => true, size: 100, mode: 0o100600 }),
    readFile: async (target) => {
      if (target === CC_PATH)
        return JSON.stringify({ claudeAiOauth: { accessToken: CC_TOKEN } });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetch: async (url, init) => {
      if (url === WHAM)
        return Response.json({
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000 },
          },
        });
      return init.headers.Authorization === `Bearer ${CC_TOKEN}`
        ? Response.json({
            five_hour: { utilization: 20, resets_at: "2026-01-01T15:00:00Z" },
            seven_day: { utilization: 35, resets_at: "2026-01-05T00:00:00Z" },
          })
        : Response.json({ five_hour: { utilization: 10, resets_at: null } });
    },
  });
  const handlers = {};
  runtime.entry.default({
    on: (event, handler) => (handlers[event] = handler),
    registerCommand() {},
  });
  const ctx = {
    mode: "tui",
    model: { provider },
    ui: { notify() {} },
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: { apiKey: CODEX_TOKEN },
      }),
    },
  };
  const advance = async (ms) => {
    runtime.env.now += ms;
    runtime.env.intervals.at(-1).fn();
    await tick();
  };
  const reads = (url) => runtime.env.requests.filter((u) => u === url).length;
  return { ...runtime, handlers, ctx, advance, reads };
}

test("a fresh start reads Codex and Claude Code without any model message, whatever provider is selected", async () => {
  for (const provider of ["openai", "anthropic", "antigravity"]) {
    const h = start(provider);
    await h.handlers.session_start({}, h.ctx);
    await tick();
    assert.equal(h.reads(WHAM), 1, provider);
    // Claude Code and native Anthropic both use the usage endpoint.
    assert.ok(h.reads(USAGE) >= 1, provider);
    assert.match(text(panel(h.env, "subscription:limits")), /75/);
    assert.match(text(panel(h.env, "subscription:claude-code")), /80/);
  }
});

test("a reload inside the gap makes no read, shows the exact deferral once, then reads when due", async () => {
  const h = start();
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const wham = h.reads(WHAM);
  const usage = h.reads(USAGE);
  h.env.now += 20_000;
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.equal(h.reads(WHAM), wham);
  assert.equal(h.reads(USAGE), usage);

  const codex = panel(h.env, "subscription:limits");
  const shown = text(codex);
  assert.match(shown, /minimum refresh gap/);
  assert.match(shown, /retry in <1m/);
  assert.equal(codex.panel.keyValues.length, 2);
  assert.equal(
    (JSON.stringify(codex.panel.keyValues).match(/Waiting/g) ?? []).length,
    1,
  );
  // Codex has no provable stored account context here, so nothing is restored.
  assert.doesNotMatch(shown, /75%/);
  // Claude Code's session is provable: its last reading is shown again, with no
  // extra request (retention is covered in quota-memory.test.cjs).
  assert.match(text(panel(h.env, "subscription:claude-code")), /80% left/);

  // The countdown is local; nothing is requested until eligible.
  await h.advance(30_000);
  assert.equal(h.reads(WHAM), wham);
  assert.match(text(panel(h.env, "subscription:limits")), /retry in <1m/);

  // Codex becomes eligible first and reads with no model message.
  await h.advance(11_000);
  assert.equal(h.reads(WHAM), wham + 1);
  assert.match(text(panel(h.env, "subscription:limits")), /75/);
  assert.equal(h.reads(USAGE), usage);

  // Claude Code follows once its own five-minute gap has passed.
  await h.advance(5 * 60_000);
  assert.ok(h.reads(USAGE) > usage);
  assert.match(text(panel(h.env, "subscription:claude-code")), /80/);
});
