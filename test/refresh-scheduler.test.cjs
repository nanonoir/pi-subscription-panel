const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

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
const { createRefreshScheduler, getProcessRegistry, RETRY_STATUS } = scheduler;
const { POLL_OUTCOME, POLL_FAILURE } = outcomes;

const CODEX = contracts.PROVIDER.CODEX;
const ANTIGRAVITY = contracts.PROVIDER.ANTIGRAVITY;
const MIN = 60_000;

const success = (providerId = CODEX) => ({
  kind: POLL_OUTCOME.SUCCESS,
  providerId,
  result: {
    providerId,
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
const failure = (failureKind, extra = {}, providerId = CODEX) => ({
  kind: POLL_OUTCOME.FAILURE,
  providerId,
  failure: failureKind,
  detail: "failed",
  ...extra,
});

// Fake clock, fixed random, and deferred jobs; nothing sleeps or does I/O.
function setup({ providerId = CODEX, host = {}, random = 0, ...rest } = {}) {
  const clock = { time: 1_000_000 };
  const runs = [];
  const delivered = [];
  let enabled = true;
  const job = {
    providerId,
    enabled: () => enabled,
    run: (signal) =>
      new Promise((resolve, reject) => {
        runs.push({ signal, resolve, reject });
      }),
  };
  const create = (overrides = {}) =>
    createRefreshScheduler({
      scope: "agent-dir",
      jobs: [job],
      now: () => clock.time,
      random: () => random,
      deliver: (outcome, schedule) => {
        delivered.push({ outcome, schedule });
      },
      host,
      ...rest,
      ...overrides,
    });
  return {
    clock,
    runs,
    delivered,
    host,
    create,
    setEnabled: (value) => (enabled = value),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function finish(env, index, outcome) {
  env.runs[index].resolve(outcome);
  await settle();
}

test("never-attempted job starts on tick and holds exclusion until settled", async () => {
  const env = setup();
  const s = env.create();
  assert.deepEqual(s.tick(), [CODEX]);
  assert.equal(env.runs.length, 1);
  env.clock.time += 10 * MIN;
  assert.deepEqual(s.tick(), []);
  assert.equal(s.retry(CODEX).status, RETRY_STATUS.IN_FLIGHT);
  assert.equal(s.schedule(CODEX).inFlight, true);
  await finish(env, 0, success());
  assert.equal(s.schedule(CODEX).inFlight, false);
  assert.equal(env.delivered.length, 1);
  assert.equal(env.delivered[0].schedule.lastSuccessMs, env.clock.time);
});

test("minimum gap is anchored to attempt start and differs by activity", async () => {
  const env = setup({ providerId: ANTIGRAVITY });
  const s = env.create();
  s.tick();
  env.clock.time += 5 * MIN; // slow attempt
  await finish(env, 0, success(ANTIGRAVITY));
  // Idle gap is 20 minutes from the start, not from settlement.
  env.clock.time += 14 * MIN;
  assert.deepEqual(s.tick(), []);
  env.clock.time += MIN;
  assert.deepEqual(s.tick(), [ANTIGRAVITY]);
  await finish(env, 1, success(ANTIGRAVITY));
  // Relevant activity switches to the three-minute gap.
  s.noteActivity(ANTIGRAVITY);
  assert.equal(s.schedule(ANTIGRAVITY).recentlyActive, true);
  env.clock.time += 2 * MIN;
  assert.deepEqual(s.tick(), []);
  env.clock.time += MIN;
  assert.deepEqual(s.tick(), [ANTIGRAVITY]);
  await finish(env, 2, success(ANTIGRAVITY));
  // Activity older than ten minutes no longer counts.
  env.clock.time += 11 * MIN;
  assert.equal(s.schedule(ANTIGRAVITY).recentlyActive, false);
  assert.deepEqual(s.tick(), []);
});

test("disabled job never starts and cancels an in-flight attempt", async () => {
  const env = setup();
  const s = env.create();
  env.setEnabled(false);
  assert.deepEqual(s.tick(), []);
  assert.equal(s.retry(CODEX).status, RETRY_STATUS.DISABLED);
  env.setEnabled(true);
  s.tick();
  env.setEnabled(false);
  s.tick();
  assert.equal(env.runs[0].signal.aborted, true);
  // Exclusion persists until the transport settles; result is dropped.
  assert.equal(s.schedule(CODEX).inFlight, true);
  await finish(env, 0, success());
  assert.equal(s.schedule(CODEX).inFlight, false);
  assert.equal(s.schedule(CODEX).lastSuccessMs, undefined);
  assert.equal(env.delivered.length, 0);
});

test("recoverable failures back off exponentially with nonnegative jitter", async () => {
  const env = setup({ random: 0.5 });
  const s = env.create();
  s.tick();
  await finish(env, 0, failure(POLL_FAILURE.RECOVERABLE));
  const first = env.clock.time + 60_000 + 7_500; // base + half of 15s jitter
  assert.equal(s.schedule(CODEX).nextEligibleMs, first);
  env.clock.time = first - 1;
  assert.deepEqual(s.tick(), []);
  env.clock.time = first;
  assert.deepEqual(s.tick(), [CODEX]);
  await finish(env, 1, failure(POLL_FAILURE.RECOVERABLE));
  assert.equal(s.schedule(CODEX).failureCount, 2);
  assert.equal(
    s.schedule(CODEX).nextEligibleMs,
    env.clock.time + 120_000 + 7_500,
  );
});

test("backoff growth is capped and jitter never shrinks the delay", async () => {
  const env = setup({
    random: -5,
    backoff: { baseMs: 1000, maxMs: 4000, jitterMs: 500 },
    gaps: { [CODEX]: { activeMs: 0, idleMs: 0 } },
  });
  const s = env.create();
  for (let i = 0; i < 6; i += 1) {
    s.tick();
    await finish(env, i, failure(POLL_FAILURE.RECOVERABLE));
    env.clock.time = s.schedule(CODEX).nextEligibleMs;
  }
  const before = env.clock.time;
  s.tick();
  await finish(env, 6, failure(POLL_FAILURE.RECOVERABLE));
  assert.equal(s.schedule(CODEX).nextEligibleMs - before, 4000);
});

test("server retry deadline is honored uncapped alongside backoff", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  const retryAtMs = env.clock.time + 3 * 60 * MIN;
  await finish(
    env,
    0,
    failure(POLL_FAILURE.RATE_LIMIT, { status: 429, retryAtMs }),
  );
  assert.equal(s.schedule(CODEX).nextEligibleMs, retryAtMs);
  env.clock.time = retryAtMs - 1;
  assert.deepEqual(s.tick(), []);
  env.clock.time = retryAtMs;
  assert.deepEqual(s.tick(), [CODEX]);
  // A later success clears the deadline and failure state.
  await finish(env, 1, success());
  const state = s.schedule(CODEX);
  assert.equal(state.failureCount, 0);
  assert.equal(state.lastError, undefined);
  assert.equal(state.nextEligibleMs, retryAtMs + MIN);
});

test("authentication and manual failures block until explicit retry", async () => {
  for (const kind of [POLL_FAILURE.AUTHENTICATION, POLL_FAILURE.MANUAL]) {
    const env = setup({ providerId: ANTIGRAVITY });
    const s = env.create();
    s.tick();
    await finish(env, 0, failure(kind, {}, ANTIGRAVITY));
    assert.equal(s.schedule(ANTIGRAVITY).blocked, kind);
    env.clock.time += 24 * 60 * MIN;
    assert.deepEqual(s.tick(), []);
    s.noteActivity(ANTIGRAVITY);
    assert.deepEqual(s.tick(), []);
    assert.equal(s.retry(ANTIGRAVITY).status, RETRY_STATUS.STARTED);
    assert.equal(env.runs.length, 2);
    assert.equal(s.schedule(ANTIGRAVITY).blocked, undefined);
  }
});

test("explicit retry respects gaps and server deadlines", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  const retryAtMs = env.clock.time + 10 * MIN;
  await finish(
    env,
    0,
    failure(POLL_FAILURE.AUTHENTICATION, { status: 403, retryAtMs }),
  );
  env.clock.time += MIN;
  const deferred = s.retry(CODEX);
  assert.deepEqual(deferred, {
    status: RETRY_STATUS.DEFERRED,
    eligibleAtMs: retryAtMs,
  });
  assert.equal(env.runs.length, 1);
  // The block was cleared, so automation resumes at the deadline.
  assert.equal(s.schedule(CODEX).blocked, undefined);
  env.clock.time = retryAtMs;
  assert.deepEqual(s.tick(), [CODEX]);
});

test("explicit retry within the minimum gap is deferred, not started", async () => {
  const env = setup({ providerId: ANTIGRAVITY });
  const s = env.create();
  s.tick();
  await finish(env, 0, failure(POLL_FAILURE.MANUAL, {}, ANTIGRAVITY));
  env.clock.time += MIN;
  const result = s.retry(ANTIGRAVITY);
  assert.equal(result.status, RETRY_STATUS.DEFERRED);
  assert.equal(result.eligibleAtMs, env.clock.time - MIN + 20 * MIN);
  assert.equal(env.runs.length, 1);
});

test("cancelled outcome neither fails nor succeeds, and keeps the gap", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  await finish(env, 0, {
    kind: POLL_OUTCOME.CANCELLED,
    providerId: CODEX,
  });
  const state = s.schedule(CODEX);
  assert.equal(state.failureCount, 0);
  assert.equal(state.lastSuccessMs, undefined);
  assert.equal(state.nextEligibleMs, env.clock.time + MIN);
});

test("thrown or malformed job results become recoverable failures", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  env.runs[0].reject(new Error("secret-token-in-message"));
  await settle();
  assert.equal(env.delivered[0].outcome.failure, POLL_FAILURE.RECOVERABLE);
  assert.doesNotMatch(JSON.stringify(env.delivered), /secret-token/);
  env.clock.time = s.schedule(CODEX).nextEligibleMs;
  s.tick();
  await finish(env, 1, { kind: "success", providerId: "other" });
  assert.equal(env.delivered[1].outcome.kind, POLL_OUTCOME.FAILURE);
  assert.equal(s.schedule(CODEX).lastSuccessMs, undefined);
});

test("delivery errors do not break scheduling", async () => {
  const env = setup();
  const s = env.create({
    deliver: () => {
      throw new Error("boom");
    },
  });
  s.tick();
  await finish(env, 0, success());
  assert.equal(s.schedule(CODEX).inFlight, false);
  assert.ok(s.schedule(CODEX).lastSuccessMs !== undefined);
});

test("stop aborts, drops delivery and retains exclusion until settlement", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  s.stop();
  assert.equal(env.runs[0].signal.aborted, true);
  assert.deepEqual(s.tick(), []);
  assert.equal(s.retry(CODEX).status, RETRY_STATUS.STOPPED);
  // A reloaded controller still sees the old attempt as in flight.
  const next = env.create();
  env.clock.time += 10 * MIN;
  assert.deepEqual(next.tick(), []);
  await finish(env, 0, success());
  assert.equal(env.delivered.length, 0);
  assert.deepEqual(next.tick(), [CODEX]);
});

test("live controllers in one scope work independently; stop affects only its own", async () => {
  const env = setup();
  const delivered = { a: 0, b: 0 };
  const a = env.create({ deliver: () => void (delivered.a += 1) });
  const b = env.create({ deliver: () => void (delivered.b += 1) });
  assert.deepEqual(a.tick(), [CODEX]);
  // Per-provider exclusion is shared across live controllers.
  assert.deepEqual(b.tick(), []);
  assert.equal(b.retry(CODEX).status, RETRY_STATUS.IN_FLIGHT);
  b.stop();
  assert.equal(env.runs[0].signal.aborted, false);
  assert.notEqual(a.retry(CODEX).status, RETRY_STATUS.STOPPED);
  await finish(env, 0, success());
  assert.deepEqual(delivered, { a: 1, b: 0 });
  // The other controller keeps scheduling after the first one stopped.
  env.clock.time += MIN;
  assert.deepEqual(a.tick(), [CODEX]);
  a.stop();
  assert.equal(env.runs[1].signal.aborted, true);
});

// Walks the shared registry: only primitives, arrays, maps and plain objects.
function assertPlainRegistry(host) {
  const seen = new Set();
  const visit = (value, where) => {
    if (value === null || typeof value !== "object") {
      assert.notEqual(typeof value, "function", `function at ${where}`);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    const proto = Object.getPrototypeOf(value);
    assert.ok(
      Array.isArray(value) ||
        value instanceof Map ||
        proto === Object.prototype ||
        proto === null,
      `forbidden object at ${where}: ${value.constructor?.name}`,
    );
    const children =
      value instanceof Map ? [...value.entries()].flat() : Object.values(value);
    children.forEach((child, i) => visit(child, `${where}/${i}`));
  };
  visit(getProcessRegistry(host), "registry");
}

test("repeated ticks from two live controllers alternate fairly", async () => {
  const env = setup();
  const delivered = { a: 0, b: 0 };
  const a = env.create({ deliver: () => void (delivered.a += 1) });
  const b = env.create({ deliver: () => void (delivered.b += 1) });
  for (let i = 0; i < 4; i += 1) {
    // The first controller always ticks first at each eligibility point.
    const started = [...a.tick(), ...b.tick()];
    assert.equal(started.length, 1);
    await finish(env, i, success());
    env.clock.time += MIN;
  }
  assert.deepEqual(delivered, { a: 2, b: 2 });
});

test("a stopped waiter is removed and a missed-tick waiter expires", async () => {
  const env = setup();
  const a = env.create();
  const b = env.create();
  const c = env.create();
  a.tick();
  b.tick(); // queued at the head
  c.tick(); // queued behind b
  await finish(env, 0, success());
  env.clock.time += MIN;
  assert.deepEqual(c.tick(), []); // b holds the turn
  b.stop();
  assert.deepEqual(c.tick(), [CODEX]);
  await finish(env, 1, success());

  // A waiter that stops ticking loses its turn after the ttl.
  const d = env.create({ waiterTtlMs: 30_000 });
  const e = env.create({ waiterTtlMs: 30_000 });
  env.clock.time += 50_000; // still inside the minimum gap
  assert.deepEqual(d.tick(), []); // head
  assert.deepEqual(e.tick(), []);
  env.clock.time += 31_000;
  assert.deepEqual(e.tick(), [CODEX]);
});

test("owner replacement invalidates only that session, with late settlement", async () => {
  const env = setup();
  const delivered = [];
  const mk = (owner, tag) =>
    env.create({ owner, deliver: () => void delivered.push(tag) });
  const oldSession = mk("session-1", "old");
  const other = mk("session-2", "other");
  assert.deepEqual(oldSession.tick(), [CODEX]);
  const fresh = mk("session-1", "fresh");
  // Replacement never reaches into another controller's transport...
  assert.equal(env.runs[0].signal.aborted, false);
  assertPlainRegistry(env.host);
  // ...the stale controller retires itself, aborting only its own work.
  assert.deepEqual(oldSession.tick(), []);
  assert.equal(env.runs[0].signal.aborted, true);
  assert.equal(oldSession.retry(CODEX).status, RETRY_STATUS.STOPPED);
  oldSession.noteActivity(CODEX);
  assert.equal(fresh.schedule(CODEX).recentlyActive, false);
  // Exclusion persists until the late settlement, which delivers nothing.
  env.clock.time += 10 * MIN;
  assert.deepEqual(fresh.tick(), []);
  assert.deepEqual(other.tick(), []);
  await finish(env, 0, success());
  assert.deepEqual(delivered, []);
  assert.equal(fresh.schedule(CODEX).lastSuccessMs, undefined);
  // The fresh session queued first and acquires; the other session follows.
  assert.deepEqual(other.tick(), []);
  assert.deepEqual(fresh.tick(), [CODEX]);
  await finish(env, 1, success());
  assert.deepEqual(delivered, ["fresh"]);
  env.clock.time += MIN;
  assert.deepEqual(other.tick(), [CODEX]);
  await finish(env, 2, success());
  assert.deepEqual(delivered, ["fresh", "other"]);
});

test("malformed, invalid or empty success payloads become generic failures", async () => {
  const env = setup();
  const s = env.create();
  const bad = [
    { kind: "success", providerId: CODEX },
    {
      ...success(),
      result: { providerId: CODEX, availability: "ready", pools: [] },
    },
    {
      ...success(),
      result: { ...success().result, providerId: ANTIGRAVITY },
    },
    {
      ...success(),
      result: { ...success().result, availability: "unavailable" },
    },
    {
      ...success(),
      result: {
        providerId: CODEX,
        availability: "ready",
        pools: [
          {
            id: "main",
            windows: [{ kind: "x", remainingPercent: Number.NaN }],
          },
        ],
      },
    },
  ];
  for (let i = 0; i < bad.length; i += 1) {
    env.clock.time = s.schedule(CODEX).nextEligibleMs;
    s.tick();
    await finish(env, i, bad[i]);
    assert.equal(env.delivered[i].outcome.kind, POLL_OUTCOME.FAILURE);
    assert.equal(s.schedule(CODEX).lastSuccessMs, undefined);
  }
  assert.equal(s.schedule(CODEX).failureCount, bad.length);
});

test("registry lastError is a generic allowlisted string, never provider detail", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  await finish(
    env,
    0,
    failure(POLL_FAILURE.RATE_LIMIT, {
      detail: "Bearer sk-secret-token user@example.com",
    }),
  );
  assert.equal(s.schedule(CODEX).lastError, "Quota read was rate limited.");
  const registry = getProcessRegistry(env.host);
  const serialized = JSON.stringify([...registry.scopes.entries()], (_, v) =>
    v instanceof Map ? [...v.entries()] : v,
  );
  assert.doesNotMatch(serialized, /secret|Bearer|example\.com/);
});

test("registry survives reload with metadata only and blocks persist", async () => {
  const env = setup();
  const first = env.create();
  first.tick();
  await finish(env, 0, failure(POLL_FAILURE.AUTHENTICATION, { status: 401 }));
  first.stop();
  const second = env.create();
  assert.equal(second.schedule(CODEX).blocked, POLL_FAILURE.AUTHENTICATION);
  env.clock.time += 60 * MIN;
  assert.deepEqual(second.tick(), []);

  const registry = getProcessRegistry(env.host);
  assert.equal(registry.version, 1);
  const serialized = JSON.stringify([...registry.scopes.entries()], (_, v) =>
    v instanceof Map ? [...v.entries()] : v,
  );
  assert.doesNotMatch(serialized, /pools|windows|result|token/);
  // Scope is isolated from other agent directories.
  const other = createRefreshScheduler({
    scope: "other-dir",
    jobs: [
      {
        providerId: CODEX,
        enabled: () => true,
        run: () => new Promise(() => {}),
      },
    ],
    now: () => env.clock.time,
    random: () => 0,
    deliver: () => {},
    host: env.host,
  });
  assert.equal(other.schedule(CODEX).blocked, undefined);
});

test("global registry is shared across module instances", () => {
  const host = {};
  assert.equal(getProcessRegistry(host), getProcessRegistry(host));
  const again = load("refresh-scheduler", {
    "./quota-contracts.ts": contracts,
    "./poll-outcome.ts": outcomes,
  });
  assert.equal(again.getProcessRegistry(host), getProcessRegistry(host));
});

test("Claude Code cannot be scheduled for polling", () => {
  assert.throws(
    () =>
      createRefreshScheduler({
        scope: "x",
        jobs: [
          {
            providerId: contracts.PROVIDER.CLAUDE_CODE,
            enabled: () => true,
            run: () => Promise.resolve({}),
          },
        ],
        now: () => 0,
        random: () => 0,
        deliver: () => {},
        host: {},
      }),
    /response-driven/,
  );
});

test("activity for an unregistered provider is ignored", () => {
  const env = setup();
  const s = env.create();
  s.noteActivity(ANTIGRAVITY);
  assert.equal(s.schedule(ANTIGRAVITY), undefined);
  assert.equal(s.retry(ANTIGRAVITY).status, RETRY_STATUS.UNKNOWN);
});

test("a late failure after stop keeps a known server cooldown without publishing", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  const retryAtMs = env.clock.time + 30 * MIN;
  s.stop();
  await finish(env, 0, failure(POLL_FAILURE.RATE_LIMIT, { retryAtMs }));
  assert.equal(env.delivered.length, 0);
  const meta = getProcessRegistry(env.host)
    .scopes.get("agent-dir")
    .providers.get(CODEX);
  assert.equal(meta.serverRetryAtMs, retryAtMs);
  assert.equal(meta.failureCount, 0);
  assert.equal(meta.lastError, undefined);
  const next = env.create();
  env.clock.time += 10 * MIN;
  assert.deepEqual(next.tick(), []);
  env.clock.time = retryAtMs;
  assert.deepEqual(next.tick(), [CODEX]);
});

test("a replaced controller's late cooldown is kept but never shortens an existing deadline", async () => {
  const env = setup();
  const old = env.create({ owner: "session" });
  old.tick();
  const later = env.clock.time + 60 * MIN;
  const meta = getProcessRegistry(env.host)
    .scopes.get("agent-dir")
    .providers.get(CODEX);
  meta.serverRetryAtMs = later;
  const fresh = env.create({ owner: "session" });
  old.tick();
  await finish(
    env,
    0,
    failure(POLL_FAILURE.RATE_LIMIT, { retryAtMs: later - 20 * MIN }),
  );
  assert.equal(meta.serverRetryAtMs, later);
  assert.equal(env.delivered.length, 0);
  assert.deepEqual(fresh.tick(), []);
});

test("a late authentication failure after stop blocks the shared provider sanitized, keeping the cooldown", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  const retryAtMs = env.clock.time + 30 * MIN;
  s.stop();
  await finish(
    env,
    0,
    failure(POLL_FAILURE.AUTHENTICATION, {
      status: 401,
      detail: "Bearer sk-secret rejected",
      retryAtMs,
    }),
  );
  assert.equal(env.delivered.length, 0);
  const meta = getProcessRegistry(env.host)
    .scopes.get("agent-dir")
    .providers.get(CODEX);
  assert.equal(meta.blocked, POLL_FAILURE.AUTHENTICATION);
  assert.equal(meta.serverRetryAtMs, retryAtMs);
  assert.equal(meta.failureCount, 1);
  assert.equal(meta.lastError, "Authentication unavailable or rejected.");
  assert.doesNotMatch(JSON.stringify(meta), /secret|401/);
  const next = env.create();
  env.clock.time = retryAtMs + 60 * MIN;
  assert.deepEqual(next.tick(), []);
  assert.equal(next.schedule(CODEX).blocked, POLL_FAILURE.AUTHENTICATION);
  assert.deepEqual(next.retry(CODEX), { status: RETRY_STATUS.STARTED });
});

test("late aborted failures never record invalid, foreign or raw data", async () => {
  const env = setup();
  const s = env.create();
  s.tick();
  s.cancel(CODEX);
  await finish(
    env,
    0,
    failure(POLL_FAILURE.RATE_LIMIT, { retryAtMs: Number.NaN }),
  );
  const meta = getProcessRegistry(env.host)
    .scopes.get("agent-dir")
    .providers.get(CODEX);
  assert.equal(meta.serverRetryAtMs, undefined);
  env.clock.time += 2 * MIN;
  s.tick();
  s.cancel(CODEX);
  await finish(
    env,
    1,
    failure(
      POLL_FAILURE.RATE_LIMIT,
      { retryAtMs: env.clock.time + MIN * 99 },
      ANTIGRAVITY,
    ),
  );
  assert.equal(meta.serverRetryAtMs, undefined);
  assert.equal(meta.failureCount, 0);
  assert.equal(meta.lastError, undefined);
  assert.equal(env.delivered.length, 0);
});
