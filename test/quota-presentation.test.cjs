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
const format = load("quota-format", { "./quota-contracts.ts": contracts });
const { buildQuotaPanel } = load("quota-presentation", {
  "./quota-contracts.ts": contracts,
  "./quota-format.ts": format,
});

const now = Date.parse("2026-01-01T12:00:00Z");
const base = { expanded: true, displayUsed: false, now, staleAfterMs: 180_000 };
const win = (kind, remainingPercent, extra = {}) => ({
  kind,
  remainingPercent,
  observedAt: "2026-01-01T11:59:00Z",
  source: "response-event",
  resetsAt: "2026-01-01T14:30:00Z",
  ...extra,
});
const result = (providerId, pools, extra = {}) => ({
  providerId,
  availability: "ready",
  pools,
  ...extra,
});
const text = (panel) => panel.keyValues.map((r) => `${r.label} ${r.value}`);

test("fixed identifiers and titles, native Anthropic is not Claude Code", () => {
  const ids = ["codex", "claude-code", "antigravity", "anthropic"].map((id) =>
    buildQuotaPanel(result(id, []), base),
  );
  assert.deepEqual(
    ids.map((p) => [p.id, p.title]),
    [
      ["subscription:limits", "Codex"],
      ["subscription:claude-code", "Claude Code"],
      ["subscription:antigravity", "Antigravity"],
      ["subscription:anthropic", "Native Anthropic"],
    ],
  );
});

test("independent pools, collapsed summary and no manufactured rows", () => {
  const r = result("antigravity", [
    { id: "gemini", windows: [win("daily", 40)] },
    { id: "claude", windows: [win("daily", 90)] },
  ]);
  const open = buildQuotaPanel(r, base);
  const lines = text(open).join("\n");
  assert.match(lines, /Pool gemini/);
  assert.match(lines, /Pool claude/);
  assert.match(lines, /40% remaining/);
  assert.match(lines, /90% remaining/);
  assert.doesNotMatch(lines, /5h|1w|65%/);
  const closed = buildQuotaPanel(r, { ...base, expanded: false });
  assert.equal(closed.title, "Antigravity");
  assert.equal(closed.keyValues.length, 1);
  assert.match(closed.keyValues[0].value, /2 pools · observed 1m ago/);
  assert.doesNotMatch(closed.keyValues[0].value, /%/);
  assert.equal(closed.rows.length, 1);
});

test("no data keeps availability and never shows zero", () => {
  const panel = buildQuotaPanel(
    result("claude-code", [], { availability: "waiting" }),
    { ...base, expanded: false },
  );
  assert.equal(panel.keyValues[0].value, "Waiting for data");
  assert.doesNotMatch(panel.rows.join(), /0%|NaN/);
});

test("partial windows use reported kinds only", () => {
  const panel = buildQuotaPanel(
    result("codex", [{ id: "main", windows: [win("1w", 55)] }]),
    base,
  );
  const lines = text(panel).join("\n");
  assert.match(lines, /1w 55% remaining/);
  assert.doesNotMatch(lines, /5h/);
  assert.match(lines, /Five-hour window not reported/);
  assert.equal(
    panel.keyValues.slice(1).filter((r) => r.progress !== undefined).length,
    1,
  );
  const weeklyMissing = buildQuotaPanel(
    result("anthropic", [{ id: "m", windows: [win("5h", 55)] }]),
    base,
  );
  assert.match(text(weeklyMissing).join("\n"), /Weekly window not reported/);
  assert.match(weeklyMissing.keyValues[0].value, /Weekly window not reported/);
});

test("antigravity notes only pools with known kinds; empty pools stay visible", () => {
  const panel = buildQuotaPanel(
    result(
      "antigravity",
      [
        { id: "a", windows: [win("5h", 40)] },
        { id: "b", windows: [win("daily", 40)] },
        { id: "empty", windows: [] },
      ],
      { availability: "waiting" },
    ),
    base,
  );
  const lines = text(panel).slice(1);
  assert.equal(
    lines.filter((l) => /Weekly window not reported/.test(l)).length,
    1,
  );
  assert.ok(lines.some((l) => /Pool empty/.test(l)));
  assert.ok(lines.some((l) => /^\s*Waiting for data/.test(l)));
  assert.match(panel.keyValues[0].value, /3 pools \(1 without data\)/);
});

test("collapsed summary flags stale/unknown windows among many", () => {
  const stale = win("1w", 80, { observedAt: "2026-01-01T10:00:00Z" });
  const unknown = win("x", 80, { observedAt: "nope" });
  const mixedSame = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("5h", 20), stale] }]),
    { ...base, expanded: false },
  );
  assert.match(mixedSame.keyValues[0].value, /^STALE\/UNKNOWN 1\/2/);
  const mixedPools = buildQuotaPanel(
    result("antigravity", [
      { id: "a", windows: [win("5h", 20)] },
      { id: "b", windows: [unknown] },
    ]),
    { ...base, expanded: false },
  );
  assert.match(mixedPools.keyValues[0].value, /^STALE\/UNKNOWN 1\/2/);
  assert.doesNotMatch(mixedPools.keyValues[0].value, /%/);
});

test("freshness warning survives bounding with error, out-of-range and long detail", () => {
  const stale = win("1w", 80, { observedAt: "2026-01-01T10:00:00Z" });
  const tight = win("5h", -50, { kind: "k".repeat(24) });
  const single = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [stale] }], {
      availability: "error",
      detail: "d".repeat(500),
    }),
    { ...base, expanded: false },
  );
  assert.match(single.keyValues[0].value, /^STALE · Old data \(error\)/);
  assert.match(single.rows[0], /STALE/);
  const multi = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [tight, stale] }], {
      availability: "error",
      detail: "d".repeat(500),
    }),
    { ...base, expanded: false },
  );
  assert.match(multi.keyValues[0].value, /^STALE\/UNKNOWN 1\/2/);
  assert.match(multi.keyValues[0].value, /k{24}.*out of range/);
  assert.ok(Array.from(multi.rows[0]).length <= 160);
  assert.match(multi.rows[0], /STALE\/UNKNOWN/);
  assert.match(multi.rows[0], /…$/);
  const unknown = buildQuotaPanel(
    result("codex", [
      { id: "p", windows: [win("5h", 20, { observedAt: "x" })] },
    ]),
    { ...base, expanded: false },
  );
  assert.match(unknown.keyValues[0].value, /^AGE UNKNOWN · /);
});

test("non-finite percentages are unavailable, never a zero bar", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    const raw = win("5h", bad);
    const panel = buildQuotaPanel(
      result("codex", [{ id: "p", windows: [raw] }]),
      base,
    );
    const row = panel.keyValues[1];
    assert.match(row.value, /^Unavailable/);
    assert.equal(row.progress, undefined);
    assert.notEqual(row.valueRole, "success");
    assert.match(panel.keyValues[0].value, /Unavailable/);
    assert.doesNotMatch(text(panel).join("\n"), /NaN|Infinity|%/);
    assert.ok(Object.is(raw.remainingPercent, bad));
  }
});

test("used/remaining labels, clamped display with raw preserved, semantics", () => {
  const raw = win("w", 120);
  const r = result("codex", [{ id: "p", windows: [raw] }]);
  const remaining = buildQuotaPanel(r, base).keyValues[1];
  assert.match(remaining.value, /^100% remaining/);
  assert.match(remaining.value, /reported 120% remaining, out of range/);
  assert.equal(remaining.progress, 1);
  assert.equal(raw.remainingPercent, 120);
  const used = buildQuotaPanel(r, { ...base, displayUsed: true }).keyValues[1];
  assert.match(used.value, /^0% used/);
  assert.equal(used.progress, 0);
  const role = (pct, displayUsed = false) =>
    buildQuotaPanel(result("codex", [{ id: "p", windows: [win("w", pct)] }]), {
      ...base,
      displayUsed,
    }).keyValues[1];
  assert.equal(role(10).valueRole, "warning");
  assert.match(role(10).value, /LOW/);
  assert.equal(role(30).valueRole, "caution");
  assert.match(role(30).value, /limited/);
  assert.equal(role(31).valueRole, "success");
  assert.equal(role(5, true).valueRole, "warning");
  assert.match(role(5, true).value, /^95% used/);
  assert.equal(role(-5).value.startsWith("0% remaining"), true);
});

test("countdown, observation age and stale criterion", () => {
  const fresh = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("w", 50)] }]),
    base,
  );
  assert.match(text(fresh)[2], /resets in 2h 30m · observed 1m ago$/);
  const old = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("w", 50)] }], {
      availability: "error",
      detail: "boom\u001b[31m\n",
    }),
    { ...base, staleAfterMs: 30_000 },
  );
  const lines = text(old).join("\n");
  assert.match(lines, /STALE/);
  assert.match(old.keyValues[0].value, /^STALE · Old data \(error\)/);
  assert.match(lines, /State Error · boom/);
  assert.ok(!lines.includes("\u001b"));
});

test("missing or invalid dates are explicit, never NaN", () => {
  const bad = win("w", 50, { observedAt: "nope", resetsAt: "also nope" });
  const none = win("x", 50, { resetsAt: undefined });
  const lines = text(
    buildQuotaPanel(result("codex", [{ id: "p", windows: [bad, none] }]), {
      ...base,
      staleAfterMs: Number.NaN,
    }),
  ).join("\n");
  assert.match(lines, /reset unknown · age unknown/);
  assert.match(lines, /reset unknown · observed 1m ago/);
  assert.doesNotMatch(lines, /NaN/);
  assert.match(lines, /STALE\/UNKNOWN 1\/2/);
});

test("rows mirror key values and are bounded with explicit overflow", () => {
  const pools = Array.from({ length: 12 }, (_, i) => ({
    id: `pool-${i}`,
    windows: [win("k".repeat(300), 50)],
  }));
  const panel = buildQuotaPanel(result("antigravity", pools), base);
  assert.equal(panel.keyValues.length, 24);
  assert.equal(panel.rows.length, 24);
  assert.match(panel.rows[23], /more rows omitted/);
  assert.ok(panel.rows.every((r) => Array.from(r).length <= 160));
  assert.ok(
    panel.keyValues.every(
      (r) => Array.from(r.label).length + Array.from(r.value).length <= 160,
    ),
  );
  assert.ok(Array.from(panel.title).length <= 48);
});
