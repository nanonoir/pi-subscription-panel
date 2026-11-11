const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

const { createRefreshRuntime } = loadRuntime({
  entry: "refresh-runtime",
}).entry;
const { defaultPreferences } = loadRuntime({ entry: "preferences" }).entry;

const T0 = 1_000_000;
const SEC = 1000;
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((done) => setImmediate(done));

const window = (source = "read-only-endpoint") => ({
  kind: "5h",
  remainingPercent: 70,
  observedAt: "2026-01-01T12:00:00.000Z",
  source,
});
const ready = (providerId, source) => ({
  providerId,
  availability: "ready",
  pools: [{ id: "default", windows: [window(source)] }],
});
const success = (providerId) => ({
  kind: "success",
  providerId,
  result: ready(providerId),
});
const failure = (providerId, kind, extra = {}) => ({
  kind: "failure",
  providerId,
  failure: kind,
  detail: "failed",
  ...extra,
});

// Fake clock, fixed jitter, deferred readers and Antigravity polls. Several
// runtimes may share one process registry host to model reload and exclusion.
function setup({ host = {}, owner = "a", clock = { t: T0 }, mutate } = {}) {
  const prefs = defaultPreferences();
  mutate?.(prefs);
  const calls = { codex: [], anthropic: [], antigravity: [] };
  const delivered = [];
  const deferred = [];
  const reader = (id) => (signal) =>
    new Promise((resolve) => calls[id].push({ signal, resolve }));
  const runtime = createRefreshRuntime({
    scope: "synthetic-agent-dir",
    owner,
    preferences: () => prefs,
    readers: { codex: reader("codex"), anthropic: reader("anthropic") },
    antigravity: {
      poll: ({ signal }) =>
        new Promise((resolve) => calls.antigravity.push({ signal, resolve })),
    },
    // Deferred-start notices are waiting states, never quota; kept apart.
    deliver: (result) =>
      (result.availability === "waiting" ? deferred : delivered).push(result),
    now: () => clock.t,
    random: () => 0,
    host,
  });
  runtime.start();
  return { runtime, prefs, calls, delivered, deferred, clock, host };
}

test("a reload inside the gap reports the exact eligible time without reading", async () => {
  const host = {};
  const clock = { t: T0 };
  const first = setup({ host, clock });
  first.runtime.tick();
  first.calls.codex[0].resolve({
    kind: "success",
    providerId: "codex",
    result: {
      providerId: "codex",
      availability: "ready",
      pools: [
        {
          id: "default",
          windows: [
            {
              kind: "5h",
              remainingPercent: 75,
              observedAt: new Date(T0).toISOString(),
              source: "read-only-endpoint",
            },
          ],
        },
      ],
    },
  });
  await flush();
  first.runtime.stop();
  clock.t += 20 * SEC;
  const reload = setup({ host, clock, owner: "b" });
  assert.equal(reload.calls.codex.length, 0);
  const codex = reload.deferred.find((item) => item.providerId === "codex");
  assert.equal(codex.availability, "waiting");
  assert.deepEqual(plain(codex.pools), []);
  assert.equal(codex.retryAt, new Date(T0 + 60 * SEC).toISOString());
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 0);
  clock.t += 41 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 1);
});

test("a late old request's Retry-After updates the empty deferred deadline without an early read", async () => {
  const host = {};
  const clock = { t: T0 };
  const first = setup({ host, clock });
  first.runtime.tick();
  first.runtime.stop();
  const reload = setup({ host, clock, owner: "b" });
  clock.t += 10 * SEC;
  first.calls.codex[0].resolve(
    failure("codex", "rate-limit", { retryAtMs: T0 + 600 * SEC }),
  );
  await flush();
  reload.runtime.tick();
  // The late failure is retained as safe metadata: the panel now names the
  // failure (reason unknown here) and the server deadline, not the gap.
  const shown = reload.delivered.filter((item) => item.providerId === "codex");
  assert.equal(shown.at(-1).availability, "error");
  assert.deepEqual(plain(shown.at(-1).pools), []);
  assert.match(shown.at(-1).detail, /Last read failed: reason unknown/);
  assert.match(shown.at(-1).detail, /waiting on server deadline/);
  assert.equal(shown.at(-1).retryAt, new Date(T0 + 600 * SEC).toISOString());
  assert.equal(reload.calls.codex.length, 0);
  clock.t = T0 + 599 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 0);
  clock.t = T0 + 601 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 1);
});

const poll = (result, meta = {}, settled = Promise.resolve()) => ({
  result,
  meta,
  settled,
});
const count = (calls) => ({
  codex: calls.codex.length,
  anthropic: calls.anthropic.length,
  antigravity: calls.antigravity.length,
});

test("only Codex and native Anthropic start by default; Antigravity stays off", async () => {
  const { runtime, calls } = setup();
  runtime.tick();
  await flush();
  assert.deepEqual(count(calls), { codex: 1, anthropic: 1, antigravity: 0 });
  runtime.noteActivity("antigravity");
  runtime.tick();
  assert.equal(calls.antigravity.length, 0);
});

test("Claude Code is never polled, retried or treated as a passive observation", async () => {
  const { runtime, calls } = setup();
  assert.deepEqual(plain(runtime.retry("claude-code")), { status: "unknown" });
  runtime.observed("claude-code");
  runtime.noteActivity("claude-code");
  runtime.tick();
  await flush();
  assert.deepEqual(count(calls), { codex: 1, anthropic: 1, antigravity: 0 });
});

test("configured Codex minimum gap anchors to attempt starts", async () => {
  const { runtime, calls, clock } = setup({
    mutate: (prefs) => (prefs.refresh.codexSeconds = 300),
  });
  runtime.tick();
  calls.codex[0].resolve(success("codex"));
  await flush();
  clock.t += 61 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 1);
  clock.t += 240 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 2);
});

test("a 429 deadline is honored and delivered as a safe error", async () => {
  const { runtime, calls, clock, delivered } = setup();
  runtime.tick();
  calls.codex[0].resolve(
    failure("codex", "rate-limit", {
      status: 429,
      detail: "HTTP 429",
      retryAtMs: T0 + 10 * 60 * SEC,
    }),
  );
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].availability, "error");
  assert.equal(delivered[0].detail, "HTTP 429");
  assert.deepEqual(plain(delivered[0].pools), []);
  assert.equal(
    delivered[0].retryAt,
    new Date(T0 + 10 * 60 * SEC).toISOString(),
  );
  clock.t = T0 + 10 * 60 * SEC - 1;
  runtime.tick();
  assert.equal(calls.codex.length, 1);
  clock.t = T0 + 10 * 60 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 2);
});

test("known 401/403 stops automation until an explicit retry, respecting gaps", async () => {
  const { runtime, calls, clock, delivered } = setup();
  runtime.tick();
  calls.codex[0].resolve(failure("codex", "authentication", { status: 401 }));
  await flush();
  assert.match(
    delivered[0].detail,
    /manual retry: \/subscriptions retry codex/,
  );
  clock.t += 3600 * SEC;
  runtime.tick();
  runtime.preferencesChanged();
  assert.equal(calls.codex.length, 1);
  assert.deepEqual(plain(runtime.retry("codex")), { status: "started" });
  assert.equal(calls.codex.length, 2);
});

test("an immediate retry is deferred to the minimum gap and starts no request", async () => {
  const { runtime, calls, clock } = setup();
  runtime.tick();
  calls.codex[0].resolve(failure("codex", "authentication", { status: 403 }));
  await flush();
  clock.t += 10 * SEC;
  assert.deepEqual(plain(runtime.retry("codex")), {
    status: "deferred",
    eligibleAtMs: T0 + 60 * SEC,
  });
  assert.equal(calls.codex.length, 1);
});

test("Antigravity opt-in polls once; exclusion lasts until the child has settled", async () => {
  let settle;
  const settled = new Promise((done) => (settle = done));
  const { runtime, prefs, calls, delivered, clock } = setup();
  prefs.refresh.antigravity.mode = "auto";
  runtime.tick();
  await flush();
  assert.equal(calls.antigravity.length, 1);
  calls.antigravity[0].resolve(
    poll(ready("antigravity", "official-cli"), {}, settled),
  );
  await flush();
  assert.equal(delivered.length, 0);
  clock.t += 3 * 3600 * SEC;
  runtime.tick();
  await flush();
  assert.equal(calls.antigravity.length, 1);
  settle();
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].availability, "ready");
  assert.equal(delivered[0].providerId, "antigravity");
});

test("an indeterminate Antigravity error pauses automation until manual retry", async () => {
  const { runtime, prefs, calls, delivered, clock } = setup();
  prefs.refresh.antigravity.mode = "auto";
  runtime.tick();
  calls.antigravity[0].resolve(
    poll(
      {
        providerId: "antigravity",
        availability: "error",
        pools: [],
        detail: "Quota refresh failed",
      },
      { requireManualRetry: true },
    ),
  );
  await flush();
  const error = delivered.at(-1);
  assert.equal(error.availability, "error");
  assert.match(error.detail, /\/subscriptions retry antigravity/);
  clock.t += 6 * 3600 * SEC;
  runtime.tick();
  assert.equal(calls.antigravity.length, 1);
  // The configured idle minimum still applies to manual retry.
  clock.t = T0 + 10 * SEC;
  assert.deepEqual(plain(runtime.retry("antigravity")), {
    status: "deferred",
    eligibleAtMs: T0 + 1200 * SEC,
  });
  clock.t = T0 + 1201 * SEC;
  assert.deepEqual(plain(runtime.retry("antigravity")), { status: "started" });
  assert.equal(calls.antigravity.length, 2);
});

test("a thrown Antigravity poll is treated as an indeterminate manual-retry failure", async () => {
  const clock = { t: T0 };
  const host = {};
  const prefs = defaultPreferences();
  prefs.refresh.antigravity.mode = "auto";
  const delivered = [];
  const runtime = createRefreshRuntime({
    scope: "synthetic-agent-dir",
    owner: "a",
    preferences: () => prefs,
    readers: {
      codex: () => new Promise(() => {}),
      anthropic: () => new Promise(() => {}),
    },
    antigravity: { poll: () => Promise.reject(new Error("secret detail")) },
    deliver: (result) => delivered.push(result),
    now: () => clock.t,
    random: () => 0,
    host,
  });
  runtime.start();
  runtime.tick();
  await flush();
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(JSON.stringify(delivered), /secret/);
  assert.match(delivered[0].detail, /manual retry/);
});

test("disabling Antigravity aborts the local job and drops its result", async () => {
  const { runtime, prefs, calls, delivered } = setup();
  prefs.refresh.antigravity.mode = "auto";
  runtime.tick();
  await flush();
  const { signal, resolve } = calls.antigravity[0];
  prefs.refresh.antigravity.mode = "off";
  runtime.preferencesChanged();
  assert.equal(signal.aborted, true);
  resolve(
    poll(
      { providerId: "antigravity", availability: "waiting", pools: [] },
      { cancelled: true },
    ),
  );
  await flush();
  assert.equal(delivered.length, 0);
});

test("collapsed refresh pauses starts without reading on toggle or clearing backoff", async () => {
  const { runtime, prefs, calls, clock } = setup();
  runtime.tick();
  calls.codex[0].resolve(failure("codex", "recoverable"));
  calls.anthropic[0].resolve(success("anthropic"));
  await flush();
  prefs.refresh.whileCollapsed = false;
  prefs.expandedProviders = [];
  clock.t += 30 * SEC;
  runtime.preferencesChanged();
  runtime.tick();
  prefs.expandedProviders = ["codex"];
  runtime.preferencesChanged();
  // Expansion alone never reads and the pending backoff is retained.
  assert.equal(calls.codex.length, 1);
  runtime.tick();
  assert.equal(calls.codex.length, 1);
  clock.t += 31 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 2);
  // Native Anthropic stays collapsed and therefore paused.
  assert.equal(calls.anthropic.length, 1);
});

test("collapsing with the pause setting aborts an in-flight read and drops it", async () => {
  const { runtime, prefs, calls, delivered } = setup();
  runtime.tick();
  prefs.refresh.whileCollapsed = false;
  prefs.expandedProviders = ["anthropic"];
  runtime.preferencesChanged();
  assert.equal(calls.codex[0].signal.aborted, true);
  assert.equal(calls.anthropic[0].signal.aborted, false);
  calls.codex[0].resolve(success("codex"));
  await flush();
  assert.equal(delivered.length, 0);
});

test("stop aborts local jobs, drops results and keeps exclusion until settlement", async () => {
  const host = {};
  const clock = { t: T0 };
  const first = setup({ host, clock });
  first.runtime.tick();
  first.runtime.stop();
  assert.equal(first.calls.codex[0].signal.aborted, true);
  assert.equal(first.calls.anthropic[0].signal.aborted, true);

  const reload = setup({ host, clock, owner: "b" });
  clock.t += 3600 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 0);

  first.calls.codex[0].resolve(success("codex"));
  first.calls.anthropic[0].resolve(success("anthropic"));
  await flush();
  assert.equal(first.delivered.length, 0);
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 1);
});

test("a passive response defers polling and drops an older in-flight result", async () => {
  const { runtime, calls, delivered, clock } = setup();
  runtime.observed("codex");
  runtime.tick();
  await flush();
  assert.equal(calls.codex.length, 0);
  assert.equal(calls.anthropic.length, 1);
  clock.t += 61 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 1);
  runtime.observed("codex");
  calls.codex[0].resolve(success("codex"));
  await flush();
  assert.equal(delivered.length, 0);
});

test("a passive 5h response racing a two-window read keeps the newer 5h and the weekly's original age", async () => {
  const { mergeObservation } = loadRuntime({
    entry: "provider-adapters",
  }).entry;
  const { runtime, calls, delivered, clock } = setup();
  const win = (kind, remainingPercent, observedAt) => ({
    kind,
    remainingPercent,
    observedAt,
    source: "read-only-endpoint",
  });
  const result = (windows) => ({
    providerId: "codex",
    availability: "ready",
    pools: [{ id: "default", windows }],
  });
  runtime.tick();
  await flush();
  // Request starts at T0; the passive response lands at T0+5s; the read
  // completes at T0+10s and is stamped with that later completion time.
  const iso = (ms) => new Date(ms).toISOString();
  clock.t += 5 * SEC;
  const passiveAt = iso(clock.t);
  const passive = result([win("5h", 55, passiveAt)]);
  runtime.observed("codex", passive);
  clock.t += 5 * SEC;
  const readAt = iso(clock.t);
  calls.codex[0].resolve({
    kind: "success",
    providerId: "codex",
    result: result([win("5h", 70, readAt), win("weekly", 40, readAt)]),
  });
  await flush();
  assert.equal(delivered.length, 1);
  const state = mergeObservation(passive, delivered[0]);
  const windows = Object.fromEntries(
    state.pools[0].windows.map((item) => [item.kind, item]),
  );
  assert.equal(windows["5h"].remainingPercent, 55);
  assert.equal(windows["5h"].observedAt, passiveAt);
  assert.equal(windows.weekly.remainingPercent, 40);
  assert.equal(windows.weekly.observedAt, readAt);
});

test("a stale passive diagnostic during a newer read does not suppress the read window", async () => {
  const { mergeObservation } = loadRuntime({
    entry: "provider-adapters",
  }).entry;
  const { runtime, calls, delivered, clock } = setup();
  const win = (kind, remainingPercent, observedAt) => ({
    kind,
    remainingPercent,
    observedAt,
    source: "read-only-endpoint",
  });
  const result = (windows) => ({
    providerId: "codex",
    availability: "ready",
    pools: [{ id: "default", windows }],
  });
  const iso = (ms) => new Date(ms).toISOString();
  runtime.tick();
  await flush();
  // The diagnostic carries a timestamp 60s before the attempt started.
  const stalePassive = result([win("5h", 90, iso(clock.t - 60 * SEC))]);
  clock.t += 5 * SEC;
  runtime.observed("codex", stalePassive);
  clock.t += 5 * SEC;
  const readAt = iso(clock.t);
  calls.codex[0].resolve({
    kind: "success",
    providerId: "codex",
    result: result([win("5h", 70, readAt), win("weekly", 40, readAt)]),
  });
  await flush();
  assert.equal(delivered.length, 1);
  const state = mergeObservation(stalePassive, delivered[0]);
  const windows = Object.fromEntries(
    state.pools[0].windows.map((item) => [item.kind, item]),
  );
  assert.equal(windows["5h"].remainingPercent, 70);
  assert.equal(windows["5h"].observedAt, readAt);
  assert.equal(windows.weekly.observedAt, readAt);
});

test("a passive response never clears a manual block and explicit retry overrides deferral", async () => {
  const { runtime, calls, clock } = setup();
  runtime.tick();
  calls.codex[0].resolve(failure("codex", "authentication", { status: 401 }));
  await flush();
  runtime.observed("codex");
  clock.t += 120 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 1);
  assert.deepEqual(plain(runtime.retry("codex")), { status: "started" });
});

test("a late 401 after stop/reload blocks the shared provider, visible on the next start", async () => {
  const host = {};
  const clock = { t: T0 };
  const first = setup({ host, clock });
  first.runtime.tick();
  first.runtime.stop();
  const reload = setup({ host, clock, owner: "b" });
  first.calls.codex[0].resolve(
    failure("codex", "authentication", {
      status: 401,
      detail: "Bearer sk-secret",
    }),
  );
  await flush();
  assert.equal(first.delivered.length, 0);
  clock.t += 3600 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 0);
  // A later start surfaces the retained block with fixed text only.
  const third = setup({ host, clock, owner: "c" });
  assert.equal(third.delivered.length, 1);
  assert.equal(third.delivered[0].providerId, "codex");
  assert.match(
    third.delivered[0].detail,
    /^Last read failed: reason unknown · manual retry: \/subscriptions retry codex$/,
  );
  assert.doesNotMatch(JSON.stringify(third.delivered), /secret|401/);
  third.runtime.tick();
  assert.equal(third.calls.codex.length, 0);
});

test("a passive observation after a surfaced block re-shows the guidance without a read", async () => {
  const { runtime, calls, delivered, clock } = setup();
  runtime.tick();
  calls.codex[0].resolve(failure("codex", "authentication", { status: 401 }));
  await flush();
  assert.equal(delivered.length, 1);
  runtime.observed("codex");
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].availability, "error");
  assert.deepEqual(plain(delivered[1].pools), []);
  assert.match(
    delivered[1].detail,
    /manual retry: \/subscriptions retry codex/,
  );
  clock.t += 3600 * SEC;
  runtime.tick();
  assert.equal(calls.codex.length, 1);
  assert.equal(delivered.length, 2);
});

test("a late 401 settling after the replacement started is surfaced once at the next tick, without reads", async () => {
  const host = {};
  const clock = { t: T0 };
  const first = setup({ host, clock });
  first.runtime.tick();
  const reload = setup({ host, clock, owner: "b" });
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 0);
  first.runtime.stop();
  first.calls.codex[0].resolve(
    failure("codex", "authentication", {
      status: 401,
      detail: "Bearer sk-secret",
    }),
  );
  await flush();
  assert.equal(first.delivered.length, 0);
  assert.equal(reload.delivered.length, 0);
  clock.t += 3600 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.codex.length, 0);
  assert.equal(reload.delivered.length, 1);
  assert.equal(reload.delivered[0].providerId, "codex");
  assert.equal(reload.delivered[0].availability, "error");
  assert.deepEqual(plain(reload.delivered[0].pools), []);
  assert.match(
    reload.delivered[0].detail,
    /^Last read failed: reason unknown · manual retry: \/subscriptions retry codex$/,
  );
  assert.doesNotMatch(JSON.stringify(reload.delivered), /secret|401/);
  clock.t += 3600 * SEC;
  reload.runtime.tick();
  assert.equal(reload.delivered.length, 1);
  assert.equal(reload.calls.codex.length, 0);
});

test("a block stays visible when a passive response supersedes the failed read", async () => {
  const { runtime, calls, delivered } = setup();
  runtime.tick();
  runtime.observed("codex");
  calls.codex[0].resolve(failure("codex", "authentication", { status: 401 }));
  await flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].availability, "error");
  assert.deepEqual(plain(delivered[0].pools), []);
  assert.match(
    delivered[0].detail,
    /manual retry: \/subscriptions retry codex/,
  );
  // Passive supersession still drops non-blocking stale failures.
  const other = setup();
  other.runtime.tick();
  other.runtime.observed("codex");
  other.calls.codex[0].resolve(failure("codex", "recoverable"));
  await flush();
  assert.equal(other.delivered.length, 0);
});

test("re-enabling Antigravity surfaces a retained block once, with no read", async () => {
  const host = {};
  const clock = { t: T0 };
  const first = setup({ host, clock });
  first.prefs.refresh.antigravity.mode = "auto";
  first.runtime.tick();
  first.calls.antigravity[0].resolve(
    poll(
      {
        providerId: "antigravity",
        availability: "error",
        pools: [],
        detail: "raw secret",
      },
      { requireManualRetry: true },
    ),
  );
  await flush();
  first.runtime.stop();

  const reload = setup({ host, clock, owner: "b" });
  assert.equal(reload.delivered.length, 0);
  reload.prefs.refresh.antigravity.mode = "auto";
  reload.runtime.preferencesChanged();
  assert.equal(reload.delivered.length, 1);
  assert.equal(reload.delivered[0].providerId, "antigravity");
  assert.equal(reload.delivered[0].availability, "error");
  assert.deepEqual(plain(reload.delivered[0].pools), []);
  assert.match(
    reload.delivered[0].detail,
    /manual retry: \/subscriptions retry antigravity/,
  );
  assert.doesNotMatch(JSON.stringify(reload.delivered), /secret/);
  reload.runtime.preferencesChanged();
  assert.equal(reload.delivered.length, 1);
  clock.t += 6 * 3600 * SEC;
  reload.runtime.tick();
  assert.equal(reload.calls.antigravity.length, 0);
});

test("retry before the scheduler exists makes no request", () => {
  const prefs = defaultPreferences();
  const runtime = createRefreshRuntime({
    scope: "synthetic-agent-dir",
    owner: "a",
    preferences: () => prefs,
    readers: {
      codex: () => assert.fail("no read"),
      anthropic: () => assert.fail("no read"),
    },
    antigravity: { poll: () => assert.fail("no poll") },
    deliver: () => assert.fail("no delivery"),
    now: () => T0,
    random: () => 0,
    host: {},
  });
  assert.equal(runtime.retry("codex"), undefined);
  runtime.tick();
  runtime.preferencesChanged();
});

const REGISTRY_KEY = Symbol.for("pi-subscription-panel.refresh-registry.v1");
// The registry must come from the runtime's own realm, so a first runtime
// creates it and the legacy record is injected into its provider map.
const legacyHost = (meta) => {
  const host = {};
  setup({ host }).runtime.stop();
  host[REGISTRY_KEY].scopes
    .get("synthetic-agent-dir")
    .providers.set("codex", { waiters: [], ...meta });
  return host;
};
test("a retained HTTP 401 block shows the status with sanitized retry guidance", async () => {
  const { runtime, calls, delivered } = setup();
  runtime.tick();
  calls.codex[0].resolve(
    failure("codex", "authentication", {
      reason: "http",
      status: 401,
      detail: "Bearer sk-secret",
    }),
  );
  await flush();
  assert.equal(delivered.length, 1);
  runtime.observed("codex");
  assert.match(
    delivered[1].detail,
    /^Last read failed: HTTP 401 · manual retry: \/subscriptions retry codex$/,
  );
  assert.doesNotMatch(delivered[1].detail, /secret/);
});

test("a legacy blocked record without lastFailure names an unknown reason and makes no read", () => {
  const host = legacyHost({
    failureCount: 1,
    lastError: "Authentication unavailable or rejected.",
    blocked: "authentication",
    lastAttemptMs: T0,
  });
  const reload = setup({ host, clock: { t: T0 + 20 * SEC } });
  reload.runtime.tick();
  const shown = reload.delivered.filter((item) => item.providerId === "codex");
  assert.equal(shown.length, 1);
  assert.match(
    shown[0].detail,
    /^Last read failed: reason unknown · manual retry: \/subscriptions retry codex$/,
  );
  assert.equal(reload.calls.codex.length, 0);
});

test("a legacy gap record with failureCount does not imply a previous success", () => {
  const host = legacyHost({ failureCount: 2, lastAttemptMs: T0 });
  const reload = setup({ host, clock: { t: T0 + 20 * SEC } });
  const codex = reload.delivered.find((item) => item.providerId === "codex");
  assert.equal(codex.availability, "error");
  assert.deepEqual(plain(codex.pools), []);
  assert.match(
    codex.detail,
    /Last read failed: reason unknown · waiting on minimum refresh gap/,
  );
  assert.equal(codex.retryAt, new Date(T0 + 60 * SEC).toISOString());
  assert.equal(reload.calls.codex.length, 0);
});
