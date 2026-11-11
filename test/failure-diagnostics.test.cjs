const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

// Synthetic only: no credential, network or Pi session is touched.

// ---- Scheduler and outcome metadata -----------------------------------------

function load(name, mocks = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, `../extensions/${name}.ts`),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${compiled}\n})`)(
    exports,
    (id) => mocks[id] ?? require(id),
  );
  return exports;
}
const contracts = load("quota-contracts");
const outcomes = load("poll-outcome", { "./quota-contracts.ts": contracts });
const scheduler = load("refresh-scheduler", {
  "./quota-contracts.ts": contracts,
  "./poll-outcome.ts": outcomes,
});
const { createRefreshScheduler, effectiveDeferral } = scheduler;
const { POLL_OUTCOME, POLL_FAILURE, FAILURE_REASON, toPollOutcome } = outcomes;
const CODEX = contracts.PROVIDER.CODEX;
const MIN = 60_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

const success = () => ({
  kind: POLL_OUTCOME.SUCCESS,
  providerId: CODEX,
  result: {
    providerId: CODEX,
    availability: "ready",
    pools: [
      {
        id: "main",
        windows: [
          {
            kind: "five-hour",
            remainingPercent: 80,
            observedAt: "2026-01-01T00:00:00.000Z",
            source: "read-only-endpoint",
          },
        ],
      },
    ],
  },
});
const failure = (extra = {}) => ({
  kind: POLL_OUTCOME.FAILURE,
  providerId: CODEX,
  failure: POLL_FAILURE.RECOVERABLE,
  detail: "raw provider text with token abc123 at /home/user/.secret",
  ...extra,
});

function setup() {
  const clock = { time: 1_000_000 };
  const runs = [];
  const host = {};
  const job = {
    providerId: CODEX,
    enabled: () => true,
    run: () => new Promise((resolve) => runs.push({ resolve })),
  };
  const create = (overrides = {}) =>
    createRefreshScheduler({
      scope: "agent-dir",
      jobs: [job],
      now: () => clock.time,
      random: () => 0,
      deliver: () => {},
      host,
      ...overrides,
    });
  const finish = async (index, outcome) => {
    runs[index].resolve(outcome);
    await settle();
  };
  return { clock, runs, create, finish };
}

test("outcomes map transport facts and exact fixed strings to allowlisted reasons", () => {
  const read = (detail, meta = {}) =>
    toPollOutcome(
      CODEX,
      { providerId: CODEX, availability: "error", pools: [], detail },
      meta,
    );
  assert.equal(read("HTTP 503", { httpStatus: 503 }).reason, "http");
  assert.equal(read("HTTP 503", { httpStatus: 503 }).status, 503);
  assert.equal(
    read("x", { authUnavailable: true }).reason,
    "session-unavailable",
  );
  assert.equal(read("timeout").reason, FAILURE_REASON.TIMEOUT);
  assert.equal(read("error de red").reason, FAILURE_REASON.NETWORK);
  assert.equal(read("error de consulta").reason, FAILURE_REASON.QUERY);
  assert.equal(
    read("ventanas ausentes o formato cambiado").reason,
    FAILURE_REASON.FORMAT,
  );
  assert.equal(
    read("x", { requireManualRetry: true }).reason,
    FAILURE_REASON.MANUAL,
  );
  // Raw or hostile text is never interpreted.
  for (const detail of ["constructor", "boom token=abc /home/x", "toString"]) {
    assert.equal(read(detail).reason, FAILURE_REASON.UNKNOWN, detail);
  }
});

test("the registry keeps only a sanitized reason, validated status and time", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  await env.finish(
    0,
    failure({ reason: "<script>", status: 999, retryAtMs: undefined }),
  );
  let { lastFailure } = s.schedule(CODEX);
  assert.deepEqual(JSON.parse(JSON.stringify(lastFailure)), {
    reason: "unknown",
    atMs: env.clock.time,
  });

  env.clock.time += 5 * MIN;
  s.tick();
  await env.finish(1, failure({ reason: "http", status: 503 }));
  ({ lastFailure } = s.schedule(CODEX));
  assert.equal(lastFailure.reason, "http");
  assert.equal(lastFailure.status, 503);
  const serialized = JSON.stringify(s.schedule(CODEX));
  assert.doesNotMatch(serialized, /abc123|secret|raw provider/);

  // A status only travels with the http reason.
  env.clock.time += 30 * MIN;
  s.tick();
  await env.finish(2, failure({ reason: "timeout", status: 503 }));
  assert.equal(s.schedule(CODEX).lastFailure.status, undefined);
});

test("deadlines are separate and ties resolve server, then backoff, then gap", async () => {
  const env = setup();
  const s = env.create();
  const start = env.clock.time;
  s.tick();
  // Gap (60s), backoff (60s, no jitter) and server deadline all coincide.
  await env.finish(
    0,
    failure({ reason: "http", status: 503, retryAtMs: start + MIN }),
  );
  let schedule = s.schedule(CODEX);
  assert.equal(schedule.gapUntilMs, start + MIN);
  assert.equal(schedule.backoffUntilMs, start + MIN);
  assert.equal(schedule.serverRetryAtMs, start + MIN);
  assert.deepEqual(JSON.parse(JSON.stringify(schedule.deferral)), {
    cause: "server",
    untilMs: start + MIN,
  });

  // Backoff and gap tie: backoff wins.
  env.clock.time = start + MIN;
  s.tick();
  const second = env.clock.time;
  await env.finish(1, failure({ reason: "network" }));
  schedule = s.schedule(CODEX);
  assert.equal(schedule.serverRetryAtMs, undefined);
  assert.equal(schedule.deferral.cause, "backoff");
  assert.equal(schedule.nextEligibleMs, second + 2 * MIN);

  // Only the later deadline counts, whatever its kind.
  assert.equal(
    effectiveDeferral({ gap: 10, backoff: 5, server: 20 }, 0).cause,
    "server",
  );
  assert.equal(
    effectiveDeferral({ gap: 30, backoff: 5, server: 20 }, 0).cause,
    "gap",
  );
  assert.equal(effectiveDeferral({ gap: 10, server: 20 }, 25), undefined);
});

test("a success clears the failure, backoff and server deadline", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  await env.finish(
    0,
    failure({
      reason: "http",
      status: 429,
      retryAtMs: env.clock.time + 10 * MIN,
    }),
  );
  assert.ok(s.schedule(CODEX).lastFailure);
  env.clock.time += 10 * MIN;
  assert.deepEqual(s.tick(), [CODEX]);
  await env.finish(1, success());
  const schedule = s.schedule(CODEX);
  assert.equal(schedule.lastFailure, undefined);
  assert.equal(schedule.backoffUntilMs, undefined);
  assert.equal(schedule.serverRetryAtMs, undefined);
  assert.equal(schedule.failureCount, 0);
  assert.equal(schedule.deferral.cause, "gap");
});

test("a retired late outcome keeps only safe failure metadata and no success", async () => {
  const env = setup();
  const old = env.create({ owner: "session" });
  old.tick();
  const fresh = env.create({ owner: "session" });
  old.tick(); // retires the old controller
  await env.finish(
    0,
    failure({
      reason: "http",
      status: 502,
      retryAtMs: env.clock.time + 5 * MIN,
    }),
  );
  let schedule = fresh.schedule(CODEX);
  assert.equal(schedule.lastFailure.reason, "http");
  assert.equal(schedule.lastFailure.status, 502);
  assert.equal(schedule.serverRetryAtMs, env.clock.time + 5 * MIN);
  assert.equal(schedule.deferral.cause, "server");
  assert.doesNotMatch(JSON.stringify(schedule), /abc123|secret|raw provider/);

  // A late success of a retired controller records nothing at all.
  const env2 = setup();
  const old2 = env2.create({ owner: "session" });
  old2.tick();
  const fresh2 = env2.create({ owner: "session" });
  old2.tick();
  await env2.finish(0, success());
  schedule = fresh2.schedule(CODEX);
  assert.equal(schedule.lastSuccessMs, undefined);
  assert.equal(schedule.lastFailure, undefined);
  assert.equal(schedule.failureCount, 0);
});

// ---- Reload message, read-only status command, eligible tick ---------------

const WHAM = "https://chatgpt.com/backend-api/wham/usage";
const BODY_SECRET = "synthetic-body-secret";
const TOKEN = `h.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  }),
).toString("base64url")}.s`;
const tick = () => new Promise((done) => setImmediate(done));
const text = (entry) => JSON.stringify(entry.panel);
const panel = (env, id) =>
  env.registrations.filter((item) => item.panel.id === id).at(-1);

function start(whamResponse) {
  const runtime = loadRuntime({
    expose: "",
    fetch: async (url) =>
      url === WHAM
        ? whamResponse()
        : Response.json({ five_hour: { utilization: 10, resets_at: null } }),
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
    model: { provider: "openai" },
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
  const reads = () => runtime.env.requests.filter((u) => u === WHAM).length;
  return { ...runtime, handlers, commands, ctx, notices, advance, reads };
}

test("after a reload the panel names the real failure and deadline, status makes no request, and the eligible tick recovers", async () => {
  let limited = true;
  const h = start(() =>
    limited
      ? new Response(BODY_SECRET, {
          status: 429,
          headers: { "retry-after": "600" },
        })
      : Response.json({
          rate_limit: {
            primary_window: { used_percent: 25, limit_window_seconds: 18000 },
          },
        }),
  );
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.equal(h.reads(), 1);

  h.env.now += 20_000;
  await h.handlers.session_start({}, h.ctx);
  await tick();
  assert.equal(h.reads(), 1);

  const shown = text(panel(h.env, "subscription:limits"));
  assert.match(shown, /Last read failed: HTTP 429/);
  assert.match(shown, /waiting on server deadline/);
  assert.match(shown, /retry in (9|10)m/);
  assert.doesNotMatch(shown, /minimum refresh gap/);
  // Claude Code has no local session: the reason is retained, and its
  // five-minute gap outlasts the one-minute backoff, so the gap is the cause.
  const claude = text(panel(h.env, "subscription:claude-code"));
  assert.match(claude, /Last read failed: session unavailable/);
  assert.match(claude, /waiting on minimum refresh gap/);

  const requests = h.env.requests.length;
  await h.commands.subscriptions.handler("status", h.ctx);
  assert.equal(h.env.requests.length, requests);
  const status = h.notices.at(-1);
  assert.match(status, /no request made/);
  assert.match(
    status,
    /Codex: polling on · last failure: HTTP 429 at 2026-01-01 12:00:00 UTC/,
  );
  assert.match(status, /server deadline 2026-01-01 12:10:00 UTC/);
  assert.match(
    status,
    /next read after 2026-01-01 12:10:00 UTC \(server retry deadline\)/,
  );
  assert.match(status, /Claude Code: .*session unavailable/);
  for (const secret of [BODY_SECRET, TOKEN, "synthetic-account"]) {
    assert.ok(!status.includes(secret), "status leaked");
    assert.ok(!shown.includes(secret), "panel leaked");
  }
  assert.equal(h.env.requests.length, requests);

  // Not due before the deadline; no read happens.
  await h.advance(9 * MIN);
  assert.equal(h.reads(), 1);
  // Eligible tick reads once without any model message; success clears errors.
  limited = false;
  await h.advance(70_000);
  assert.equal(h.reads(), 2);
  const recovered = text(panel(h.env, "subscription:limits"));
  assert.match(recovered, /75/);
  assert.doesNotMatch(recovered, /Last read failed|HTTP 429/);
  await h.commands.subscriptions.handler("status", h.ctx);
  const after = h.notices.at(-1);
  assert.match(after, /Codex: polling on · last success /);
  assert.doesNotMatch(after.split("\n")[1], /last failure|server deadline/);
});

test("a reload after a successful read still reports the minimum gap, not a failure", async () => {
  const h = start(() =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18000 },
      },
    }),
  );
  await h.handlers.session_start({}, h.ctx);
  await tick();
  h.env.now += 20_000;
  await h.handlers.session_start({}, h.ctx);
  await tick();
  const shown = text(panel(h.env, "subscription:limits"));
  assert.match(shown, /minimum refresh gap/);
  assert.doesNotMatch(shown, /Last read failed/);
});
