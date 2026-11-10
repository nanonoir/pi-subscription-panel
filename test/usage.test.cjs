const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

function loadExtension(options = {}) {
  const { entry, env } = loadRuntime({
    ...options,
    expose:
      "parseCodexUsage, parseClaudeUsage, usageFromHeaders, fetchJson, usageFailure, readCodexUsage, readClaudeUsage",
  });
  return { ...entry, env };
}

test("a weekly-only primary window is not also displayed as 5h", () => {
  const extension = loadExtension();
  const result = extension.parseCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 604800,
        reset_after_seconds: 600,
      },
      secondary_window: null,
    },
  });
  assert.equal(result.fiveHour, undefined);
  assert.equal(result.weekly.usedPercent, 42);
  assert.ok(result.weekly.resetsAt > extension.env.now);
});

test("malformed percentages never turn into unused quota; null reset remains usable", () => {
  const extension = loadExtension();
  const result = extension.parseClaudeUsage({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: "bad" },
  });
  assert.equal(result.fiveHour.usedPercent, 0);
  assert.equal(result.fiveHour.resetsAt, undefined);
  assert.equal(result.weekly, undefined);
});

test("passive Claude fractions and Codex durations are normalized", () => {
  const extension = loadExtension();
  const now = 1800000000000;
  const claude = extension.usageFromHeaders(
    {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.31",
      "anthropic-ratelimit-unified-5h-reset": "1800003600",
    },
    "claude",
    now,
  );
  assert.equal(claude.fiveHour.usedPercent, 31);
  assert.equal(claude.fiveHour.resetsAt, now + 3600000);
  const codex = extension.usageFromHeaders(
    {
      "x-codex-primary-used-percent": "88",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-after-seconds": "60",
    },
    "codex",
    now,
  );
  assert.equal(codex.fiveHour, undefined);
  assert.equal(codex.weekly.usedPercent, 88);
  assert.equal(codex.weekly.resetsAt, now + 60000);
  assert.equal(
    extension.usageFromHeaders(
      { "x-codex-primary-used-percent": "" },
      "codex",
      now,
    ),
    undefined,
  );
  assert.equal(extension.usageFromHeaders({}, "claude", now), undefined);
});

test("HTTP 429 respects Retry-After and rejects redirects", async () => {
  let request;
  const extension = loadExtension({
    fetch: async (_url, options) => {
      request = options;
      return new Response("", {
        status: 429,
        headers: { "retry-after": "3600" },
      });
    },
  });
  const before = extension.env.now;
  await assert.rejects(
    extension.fetchJson("https://api.anthropic.com/api/oauth/usage", {}),
    (error) => {
      const result = extension.usageFailure(error);
      assert.equal(result.error, "HTTP 429");
      assert.ok(result.retryAt >= before + 3600000);
      return true;
    },
  );
  assert.equal(request.redirect, "error");
});

test("a missing Codex session is reported without consulting openai auth", async () => {
  const extension = loadExtension();
  const asked = [];
  const getProviderAuth = async (provider) => {
    asked.push(provider);
    return provider === "openai-codex"
      ? { source: "ApiKey", auth: { apiKey: "synthetic-key" } }
      : { source: "OAuth", auth: { apiKey: "synthetic-openai-token" } };
  };
  const result = await extension.readCodexUsage({
    modelRegistry: { getProviderAuth },
  });
  assert.match(result.error, /sin sesión de cuota/);
  assert.deepEqual(asked, ["openai-codex"]);
  assert.deepEqual(extension.env.requests, []);
});

test("Codex account metadata is used when absent from the access token", async () => {
  const extension = loadExtension({
    credential: {
      type: "oauth",
      access: "synthetic-codex-token",
      accountId: "synthetic-account",
    },
    fetch: async (_url, options) => {
      assert.equal(options.headers["ChatGPT-Account-Id"], "synthetic-account");
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 18000 },
        },
      });
    },
  });
  const result = await extension.readCodexUsage({
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: { apiKey: "synthetic-codex-token" },
      }),
    },
  });
  assert.equal(result.fiveHour.usedPercent, 12);
});

test("Claude uses subscription headers and the read-only usage endpoint", async () => {
  const extension = loadExtension({
    fetch: async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.method, undefined);
      assert.match(options.headers["anthropic-beta"], /oauth-2025-04-20/);
      assert.equal(options.headers["x-app"], "cli");
      assert.match(options.headers["User-Agent"], /^claude-cli\//);
      return Response.json({ five_hour: { utilization: 10, resets_at: null } });
    },
  });
  const result = await extension.readClaudeUsage({
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: { apiKey: "synthetic-claude-token" },
      }),
    },
  });
  assert.equal(result.fiveHour.usedPercent, 10);
});

test("stored account metadata must belong to the resolved token", async () => {
  const codexAuth = {
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        auth: { apiKey: "synthetic-codex-token" },
      }),
    },
  };
  const other = loadExtension({
    credential: {
      type: "oauth",
      access: "synthetic-other-token",
      accountId: "synthetic-other-account",
    },
  });
  const result = await other.readCodexUsage(codexAuth);
  assert.equal(result.error, "token sin ID de cuenta Codex");
  assert.deepEqual(other.env.requests, []);
});

test("diagnostics capture one response and never expose header values", async () => {
  const extension = loadExtension();
  const handlers = {};
  const commands = {};
  const notifications = [];
  extension.default({
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerCommand: (name, command) => {
      commands[name] = command;
    },
  });
  const ctx = {
    model: { provider: "openai" },
    ui: { notify: (message) => notifications.push(message) },
  };
  const event = {
    status: 200,
    headers: {
      authorization: "synthetic-sensitive-value",
      "x-ratelimit-remaining-tokens": "synthetic-private-value",
      "set-cookie": "synthetic-cookie-value",
    },
  };
  handlers.after_provider_response(event, ctx);
  assert.equal(notifications.length, 0);
  await commands["subscription-debug"].handler("", ctx);
  handlers.after_provider_response(event, ctx);
  assert.equal(notifications.length, 2);
  assert.match(notifications[1], /HTTP 200/);
  assert.match(notifications[1], /x-ratelimit-remaining-tokens/);
  assert.doesNotMatch(notifications[1], /synthetic|authorization|set-cookie/);
  handlers.after_provider_response(event, ctx);
  assert.equal(notifications.length, 2);
  await commands["subscription-debug"].handler("", ctx);
  handlers.session_shutdown();
  handlers.after_provider_response(event, ctx);
  assert.equal(notifications.length, 3);
});
