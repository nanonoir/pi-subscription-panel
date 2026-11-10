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
const { toPollOutcome, POLL_OUTCOME, POLL_FAILURE } = load("poll-outcome", {
  "./quota-contracts.ts": contracts,
});

const CODEX = contracts.PROVIDER.CODEX;
const win = (extra = {}) => ({
  kind: "five-hour",
  remainingPercent: 40,
  observedAt: "2026-01-01T11:59:00Z",
  source: "read-only-endpoint",
  ...extra,
});
const ready = (windows = [win()], extra = {}) => ({
  providerId: CODEX,
  availability: "ready",
  pools: [{ id: "default", windows }],
  ...extra,
});
const failed = (extra = {}) => ({
  providerId: CODEX,
  availability: "error",
  pools: [],
  ...extra,
});

test("exposes const-mapped kinds", () => {
  assert.deepEqual(
    { ...POLL_OUTCOME },
    { SUCCESS: "success", FAILURE: "failure", CANCELLED: "cancelled" },
  );
  assert.deepEqual(Object.values(POLL_FAILURE).sort(), [
    "authentication",
    "manual",
    "rate-limit",
    "recoverable",
  ]);
});

test("cancellation overrides any data and carries no result", () => {
  const outcome = toPollOutcome(CODEX, ready(), {
    cancelled: true,
    httpStatus: 429,
  });
  assert.deepEqual({ ...outcome }, { kind: "cancelled", providerId: CODEX });
});

test("classification precedence: auth, rate limit, manual, recoverable", () => {
  const kind = (meta, result = failed()) =>
    toPollOutcome(CODEX, result, meta).failure;
  assert.equal(kind({ httpStatus: 401 }), "authentication");
  assert.equal(kind({ httpStatus: 403, retryAtMs: 5 }), "authentication");
  assert.equal(
    kind({ authUnavailable: true, httpStatus: 429 }),
    "authentication",
  );
  assert.equal(
    kind({ httpStatus: 429, requireManualRetry: true }),
    "rate-limit",
  );
  assert.equal(kind({ requireManualRetry: true }), "manual");
  assert.equal(kind({ httpStatus: 500 }), "recoverable");
  assert.equal(kind({ httpStatus: 400 }), "recoverable");
  assert.equal(kind({}), "recoverable");
});

test("known failure metadata is not masked by a ready result", () => {
  for (const [meta, failure] of [
    [{ httpStatus: 429 }, "rate-limit"],
    [{ httpStatus: 401 }, "authentication"],
    [{ authUnavailable: true }, "authentication"],
    [{ httpStatus: 503 }, "recoverable"],
  ]) {
    const outcome = toPollOutcome(CODEX, ready(), meta);
    assert.equal(outcome.kind, "failure");
    assert.equal(outcome.failure, failure);
    assert.equal(Object.hasOwn(outcome, "result"), false);
  }
});

test("manual flag does not demote a valid success; out-of-range status ignored", () => {
  assert.equal(
    toPollOutcome(CODEX, ready(), { requireManualRetry: true }).kind,
    "success",
  );
  for (const httpStatus of [99, 600, 429.5, NaN, "429"]) {
    const outcome = toPollOutcome(CODEX, ready(), { httpStatus });
    assert.equal(outcome.kind, "success");
  }
  const bad = toPollOutcome(CODEX, failed(), { httpStatus: 700 });
  assert.equal(bad.failure, "recoverable");
  assert.equal(Object.hasOwn(bad, "status"), false);
  assert.equal(toPollOutcome(CODEX, failed(), { httpStatus: 502 }).status, 502);
});

test("success keeps a real 0% and rebuilds only whitelisted fields", () => {
  const outcome = toPollOutcome(
    CODEX,
    ready(
      [
        win({
          remainingPercent: 0,
          resetsAt: "2026-01-01T14:00:00Z",
          token: "x",
        }),
      ],
      {
        accountId: "acct",
      },
    ),
  );
  assert.equal(outcome.kind, "success");
  const [window] = outcome.result.pools[0].windows;
  assert.equal(window.remainingPercent, 0);
  assert.equal(window.resetsAt, "2026-01-01T14:00:00Z");
  assert.equal(Object.hasOwn(window, "token"), false);
  assert.equal(Object.hasOwn(outcome.result, "accountId"), false);
});

test("non-finite or missing percentages and bad times are failures", () => {
  for (const remainingPercent of [NaN, Infinity, -Infinity, "5", undefined]) {
    const outcome = toPollOutcome(CODEX, ready([win({ remainingPercent })]));
    assert.equal(outcome.kind, "failure");
    assert.equal(outcome.failure, "recoverable");
  }
  for (const extra of [
    { observedAt: "not a date" },
    { observedAt: undefined },
    { source: "mystery" },
    { resetsAt: "garbage" },
  ]) {
    assert.equal(toPollOutcome(CODEX, ready([win(extra)])).kind, "failure");
  }
});

test("any invalid reported window fails; absent windows are valid partial", () => {
  assert.equal(
    toPollOutcome(
      CODEX,
      ready([win(), win({ kind: "weekly", remainingPercent: NaN })]),
    ).kind,
    "failure",
  );
  const partial = toPollOutcome(CODEX, {
    ...ready(),
    pools: [
      { id: "a", windows: [win()] },
      { id: "b", windows: [] },
    ],
  });
  assert.equal(partial.kind, "success");
  assert.equal(partial.result.pools[0].windows.length, 1);
});

test("empty, malformed and non-ready results are recoverable failures", () => {
  const cases = [
    ready([]),
    { ...ready(), pools: [] },
    { ...ready(), pools: undefined },
    { ...ready(), pools: [{ id: 1, windows: [win()] }] },
    { ...ready(), pools: [{ id: "a", windows: null }] },
    { ...ready(), availability: "waiting" },
    { ...ready(), availability: "unavailable" },
    null,
    undefined,
  ];
  for (const result of cases) {
    const outcome = toPollOutcome(CODEX, result);
    assert.equal(outcome.kind, "failure");
    assert.equal(outcome.failure, "recoverable");
  }
});

test("provider mismatch fails generically without foreign data", () => {
  const foreign = {
    ...ready(undefined, {
      detail: "foreign detail",
      retryAt: "2030-01-01T00:00:00Z",
    }),
    providerId: "anthropic",
  };
  const outcome = toPollOutcome(CODEX, foreign);
  assert.equal(outcome.kind, "failure");
  assert.equal(outcome.providerId, CODEX);
  assert.equal(outcome.detail, "Quota read failed.");
  assert.equal(Object.hasOwn(outcome, "retryAtMs"), false);
  assert.equal(Object.hasOwn(outcome, "pools"), false);
});

test("failures carry no windows and keep only safe detail", () => {
  const withWindows = failed({
    pools: [{ id: "x", windows: [win()] }],
    detail: "  Offline.  ",
    secret: "token",
  });
  const outcome = toPollOutcome(CODEX, withWindows, { httpStatus: 500 });
  assert.equal(outcome.detail, "Offline.");
  assert.deepEqual(Object.keys(outcome).sort(), [
    "detail",
    "failure",
    "kind",
    "providerId",
    "status",
  ]);
  const long = toPollOutcome(CODEX, failed({ detail: "x".repeat(500) }));
  assert.equal(long.detail.length, 200);
  assert.equal(
    toPollOutcome(CODEX, failed({ detail: 42 })).detail,
    "Quota read failed.",
  );
  assert.equal(
    toPollOutcome(CODEX, failed(), { authUnavailable: true }).detail,
    "Authentication unavailable or rejected.",
  );
});

test("retry deadline is the exact maximum of valid sources, never capped", () => {
  const retryAt = "2026-01-01T12:10:00Z";
  const resultMs = Date.parse(retryAt);
  const far = resultMs + 86_400_000 * 365;
  assert.equal(
    toPollOutcome(CODEX, failed({ retryAt }), { retryAtMs: far }).retryAtMs,
    far,
  );
  assert.equal(
    toPollOutcome(CODEX, failed({ retryAt }), { retryAtMs: 5 }).retryAtMs,
    resultMs,
  );
  assert.equal(
    toPollOutcome(CODEX, failed({ retryAt: "nope" }), { retryAtMs: 1 })
      .retryAtMs,
    1,
  );
  assert.equal(
    toPollOutcome(CODEX, failed({ retryAt }), { retryAtMs: NaN }).retryAtMs,
    resultMs,
  );
  // Past deadlines stay finite numbers; the scheduler decides what to do.
  const past = toPollOutcome(CODEX, failed(), {
    httpStatus: 429,
    retryAtMs: 0,
  });
  assert.equal(past.retryAtMs, 0);
  assert.equal(
    Object.hasOwn(
      toPollOutcome(CODEX, failed(), { retryAtMs: Infinity }),
      "retryAtMs",
    ),
    false,
  );
});

test("unknown CLI failure is manual only by flag, never inferred from text", () => {
  const antigravity = contracts.PROVIDER.ANTIGRAVITY;
  const result = {
    providerId: antigravity,
    availability: "error",
    pools: [],
    detail: "Unauthorized 401 rate limit 429 login required",
  };
  const plain = toPollOutcome(antigravity, result);
  assert.equal(plain.failure, "recoverable");
  assert.equal(Object.hasOwn(plain, "status"), false);
  const manual = toPollOutcome(antigravity, result, {
    requireManualRetry: true,
  });
  assert.equal(manual.failure, "manual");
  assert.equal(Object.hasOwn(manual, "status"), false);
});
