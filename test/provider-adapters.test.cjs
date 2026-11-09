const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

function load(name) {
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
  vm.runInThisContext(
    `(function(exports,require,setTimeout,clearTimeout){${compiled}\n})`,
  )(exports, (id) => (id === "./quota-contracts.ts" ? contracts : require(id)));
  return exports;
}
const contracts = load("quota-contracts");
const {
  createClaudeAdapter,
  parseAntigravity,
  waitingState,
  mergeObservation,
  projectAge,
} = load("provider-adapters");
const { AVAILABILITY, PROVIDER } = contracts;
const timestamp = 1700000000000;
const iso = new Date(timestamp).toISOString();
const diagnostic = (windows, time = timestamp) => ({
  type: "claude-code.rate-limit",
  timestamp: time,
  details: { unifiedWindows: windows },
});
const event = (...diagnostics) => ({
  message: { role: "assistant", provider: "claude-code", diagnostics },
});
const group = (name, buckets) => ({ name, buckets });
const bucket = (window, remaining_fraction, reset_time) => ({
  window,
  remaining_fraction,
  reset_time,
});
const payload = (...groups) => ({
  status: "SUCCESS",
  command: { name: "usage", data: { groups } },
});

test("Claude observes only qualifying responses and uses diagnostic milliseconds and reset seconds", () => {
  const adapter = createClaudeAdapter();
  assert.equal(adapter.refresh, undefined);
  const message = event(
    diagnostic({
      five_hour: { utilization: 0.25, resetsAt: 1700003600 },
      seven_day: { utilization: 1.2, resetsAt: "bad" },
    }),
  );
  const result = adapter.observeResponse(message);
  assert.equal(result.pools[0].windows[0].remainingPercent, 75);
  assert.equal(result.pools[0].windows[0].observedAt, iso);
  assert.equal(
    result.pools[0].windows[0].resetsAt,
    new Date(1700003600000).toISOString(),
  );
  assert.equal(result.pools[0].windows[1].remainingPercent, -20);
  assert.equal(result.pools[0].windows[1].resetsAt, undefined);
  for (const wrong of [
    { ...message.message, role: "user" },
    { ...message.message, provider: "anthropic" },
    {
      ...message.message,
      diagnostics: [{ ...message.message.diagnostics[0], type: "other" }],
    },
  ]) {
    assert.equal(adapter.observeResponse({ message: wrong }), undefined);
  }
  for (const bad of [
    null,
    {},
    event(diagnostic({ five_hour: { utilization: NaN } })),
    event(diagnostic({ five_hour: { utilization: "0" } })),
    event({
      type: "claude-code.rate-limit",
      timestamp,
      details: { utilization: 0.5 },
    }),
    event(diagnostic({ five_hour: { utilization: 0 } }, NaN)),
  ])
    assert.equal(adapter.observeResponse(bad), undefined);
  const latest = adapter.observeResponse(
    event(
      diagnostic({ five_hour: { utilization: 0.1 } }, timestamp + 1),
      diagnostic({ five_hour: { utilization: 0.8 } }),
    ),
  );
  assert.equal(latest.pools[0].windows[0].remainingPercent, 90);
});

test("state retains independent old windows, ignores old or wrong provider and projects age", () => {
  const adapter = createClaudeAdapter();
  const initial = waitingState(PROVIDER.CLAUDE_CODE);
  const first = adapter.observeResponse(
    event(
      diagnostic({
        five_hour: { utilization: 0.2 },
        seven_day: { utilization: 0.3 },
      }),
    ),
  );
  const state = mergeObservation(initial, first);
  const partial = adapter.observeResponse(
    event(diagnostic({ five_hour: { utilization: 0.4 } }, timestamp + 1000)),
  );
  const next = mergeObservation(state, partial);
  assert.equal(initial.pools.length, 0);
  assert.equal(state.pools[0].windows[0].remainingPercent, 80);
  assert.equal(
    next.pools[0].windows.find((w) => w.kind === "1w").observedAt,
    iso,
  );
  assert.strictEqual(mergeObservation(next, first), next);
  assert.strictEqual(mergeObservation(next, undefined), next);
  assert.strictEqual(
    mergeObservation(next, waitingState(PROVIDER.ANTIGRAVITY)),
    next,
  );
  const failed = mergeObservation(next, {
    providerId: PROVIDER.CLAUDE_CODE,
    availability: AVAILABILITY.ERROR,
    pools: [],
  });
  assert.equal(failed.pools[0].windows.length, 2);
  assert.equal(failed.availability, AVAILABILITY.ERROR);
  assert.deepEqual(
    projectAge(
      failed.pools[0].windows.find((w) => w.kind === "1w"),
      timestamp + 5000,
      5000,
    ),
    { ageMs: 5000, stale: true },
  );
});

test("Antigravity keeps independent pools and rejects malformed or ambiguous reports", () => {
  const input = payload(
    group("A", [
      bucket("5h", 0.5, "2024-01-01T00:00:00Z"),
      bucket("weekly", 0.2),
    ]),
    group("B", [bucket("custom", 1.2)]),
  );
  const result = parseAntigravity({ event: "result", result: input }, iso);
  assert.deepEqual(
    result.pools.map((p) => p.id),
    ["A", "B"],
  );
  assert.deepEqual(
    result.pools[0].windows.map((w) => w.kind),
    ["5h", "1w"],
  );
  assert.equal(result.pools[1].windows[0].remainingPercent, 120);
  for (const bad of [
    null,
    {},
    { ...input, status: "FAIL" },
    { ...input, command: { name: "other" } },
    payload(),
    payload(group("A", [bucket("5h", 0.5)]), group("A", [bucket("5h", 0.3)])),
    payload(group("A", [bucket("weekly", 0.5), bucket("1w", 0.3)])),
    payload(group("A", [bucket("5h", NaN)])),
    payload(group("A", [bucket("5h", 0.5), bucket("weekly", null)])),
  ])
    assert.equal(parseAntigravity(bad, iso), undefined);
});
