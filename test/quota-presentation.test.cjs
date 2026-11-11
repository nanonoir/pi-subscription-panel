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
  // Readable names, in a deterministic order independent of input order.
  assert.match(lines, /^ Claude$/m);
  assert.match(lines, /^ Gemini$/m);
  assert.ok(lines.indexOf("Claude") < lines.indexOf("Gemini"));
  assert.doesNotMatch(lines, /Pool|gemini|claude/);
  assert.match(lines, /40% left/);
  assert.match(lines, /90% left/);
  assert.doesNotMatch(lines, /5h|1w|65%/);
  const closed = buildQuotaPanel(r, { ...base, expanded: false });
  assert.equal(closed.title, "Antigravity");
  assert.deepEqual(
    closed.keyValues.map((r) => r.value),
    ["2 pools", "Claude", "90% left", "Gemini", "40% left"],
  );
  assert.doesNotMatch(closed.rows.join(), /observed/);
});

test("no data keeps availability and never shows zero", () => {
  const panel = buildQuotaPanel(
    result("claude-code", [], { availability: "waiting" }),
    { ...base, expanded: false },
  );
  assert.equal(panel.keyValues[0].value, "(waiting refresh)");
  assert.doesNotMatch(panel.rows.join(), /0%|NaN/);
  const codex = buildQuotaPanel(
    result("codex", [], { availability: "waiting" }),
    { ...base, expanded: false },
  );
  assert.equal(codex.keyValues[0].value, "Waiting for data");
});

test("reference layout: name with reset duration, then bar with percent left", () => {
  const panel = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("5h", 81)] }]),
    base,
  );
  // Expanded with windows: no duplicate summary line, the window leads.
  const [name, bar] = panel.keyValues;
  assert.equal(name.label, "5h");
  assert.equal(name.value, "2h 30m");
  assert.equal(name.progress, undefined);
  assert.equal(bar.label, "");
  assert.equal(bar.value, "81% left");
  assert.equal(bar.progress, 0.81);
  assert.doesNotMatch(text(panel).join("\n"), /reset|reinicio|remaining/i);
});

test("partial windows use reported kinds only", () => {
  const panel = buildQuotaPanel(
    result("codex", [{ id: "main", windows: [win("1w", 55)] }]),
    base,
  );
  const lines = text(panel).join("\n");
  assert.match(lines, /^1w 2h 30m$/m);
  assert.match(lines, /55% left/);
  assert.doesNotMatch(lines, /5h(?! missing)/);
  assert.match(lines, /5h missing/);
  assert.equal(
    panel.keyValues.filter((r) => r.progress !== undefined).length,
    1,
  );
  const weeklyMissing = buildQuotaPanel(
    result("anthropic", [{ id: "m", windows: [win("5h", 55)] }]),
    base,
  );
  assert.match(text(weeklyMissing).join("\n"), /1w missing/);
  const collapsed = buildQuotaPanel(
    result("anthropic", [{ id: "m", windows: [win("5h", 55)] }]),
    { ...base, expanded: false },
  );
  assert.ok(collapsed.keyValues.some((r) => r.value === "1w missing"));
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
  const lines = text(panel);
  assert.equal(lines.filter((l) => /1w missing/.test(l)).length, 1);
  assert.ok(lines.some((l) => /^\s*Empty$/.test(l)));
  assert.ok(lines.some((l) => /^\s*Waiting for data/.test(l)));
  const collapsed = buildQuotaPanel(
    result(
      "antigravity",
      [
        { id: "a", windows: [win("5h", 40)] },
        { id: "empty", windows: [] },
      ],
      { availability: "waiting" },
    ),
    { ...base, expanded: false },
  );
  const values = collapsed.keyValues.map((r) => r.value);
  assert.ok(values.includes("2 pools") && values.includes("1 without data"));
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
  assert.deepEqual(
    single.keyValues.map((r) => r.value),
    ["STALE · 2h 0m ago", "OLD (error)", "80% left", "5h missing"],
  );
  assert.match(single.rows[0], /STALE/);
  const multi = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [tight, stale] }], {
      availability: "error",
      detail: "d".repeat(500),
    }),
    { ...base, expanded: false },
  );
  assert.match(multi.keyValues[0].value, /^STALE\/UNKNOWN 1\/2/);
  assert.ok(multi.keyValues.some((r) => r.value === "CLAMP -50%"));
  assert.ok(multi.keyValues.some((r) => r.value === "EXHAUSTED"));
  assert.ok(multi.keyValues.some((r) => r.label === "k".repeat(24)));
  assert.ok(multi.rows.every((row) => Array.from(row).length <= 160));
  assert.match(multi.rows[0], /STALE\/UNKNOWN/);
  const unknown = buildQuotaPanel(
    result("codex", [
      { id: "p", windows: [win("5h", 20, { observedAt: "x" })] },
    ]),
    { ...base, expanded: false },
  );
  assert.match(unknown.keyValues[0].value, /^AGE UNKNOWN$/);
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
    const collapsed = buildQuotaPanel(
      result("codex", [{ id: "p", windows: [raw] }]),
      { ...base, expanded: false },
    );
    assert.ok(collapsed.keyValues.some((r) => r.value === "Unavailable"));
    assert.doesNotMatch(text(panel).join("\n"), /NaN|Infinity|%/);
    assert.ok(Object.is(raw.remainingPercent, bad));
  }
});

test("always remaining, even with a legacy used preference; clamped, raw preserved", () => {
  const raw = win("w", 120);
  const r = result("codex", [{ id: "p", windows: [raw] }]);
  const remaining = buildQuotaPanel(r, base).keyValues[1];
  assert.match(remaining.value, /^100% left/);
  assert.equal(remaining.value, "100% left");
  assert.doesNotMatch(remaining.value, /reported|range/);
  assert.equal(remaining.progress, 1);
  assert.equal(raw.remainingPercent, 120);
  const saved = buildQuotaPanel(r, { ...base, displayUsed: true }).keyValues[1];
  assert.match(saved.value, /^100% left/);
  assert.equal(saved.progress, 1);
  const panelFor = (pct, displayUsed = false) =>
    buildQuotaPanel(result("codex", [{ id: "p", windows: [win("w", pct)] }]), {
      ...base,
      displayUsed,
    });
  const role = (pct, displayUsed = false) =>
    panelFor(pct, displayUsed).keyValues[1];
  assert.equal(role(10).valueRole, "warning");
  assert.equal(panelFor(10).keyValues[2].value, "LOW");
  assert.equal(role(30).valueRole, "caution");
  // The ambiguous standalone "limited" row is gone; the role carries it.
  assert.ok(panelFor(30).keyValues.every((r) => r.value !== "limited"));
  assert.equal(panelFor(0).keyValues[2].value, "EXHAUSTED");
  assert.equal(panelFor(0).keyValues[2].valueRole, "error");
  assert.equal(role(30).value, "30% left");
  assert.equal(role(31).valueRole, "success");
  assert.equal(role(5, true).valueRole, "warning");
  assert.match(role(5, true).value, /^5% left/);
  assert.equal(role(5, true).progress, 0.05);
  assert.equal(role(-5).value.startsWith("0% left"), true);
});

test("countdown, observation age and stale criterion", () => {
  const fresh = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("w", 50)] }]),
    base,
  );
  // A fresh reading carries no age noise; staleness is still shown below.
  assert.equal(text(fresh)[0], "w 2h 30m");
  const old = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("w", 50)] }], {
      availability: "error",
      detail: "boom\u001b[31m\n",
    }),
    { ...base, staleAfterMs: 30_000 },
  );
  const lines = text(old).join("\n");
  // One provider-level warning; the window is neither repeated nor age-labelled.
  assert.match(lines, /^ STALE · 1m ago$/m);
  assert.match(lines, /^w 2h 30m$/m);
  assert.doesNotMatch(lines, /observed/);
  assert.equal(old.keyValues.find((r) => r.label === "w").valueRole, "caution");
  assert.match(lines, /State Error · boom/);
  const collapsed = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("w", 50)] }], {
      availability: "error",
    }),
    { ...base, expanded: false, staleAfterMs: 30_000 },
  );
  assert.deepEqual(
    collapsed.keyValues.map((r) => r.value),
    ["STALE · 1m ago", "OLD (error)", "50% left", "5h missing", "1w missing"],
  );
  assert.ok(!lines.includes("\u001b"));
});

test("collapsed overflow keeps the availability warning and the omission row", () => {
  const pools = Array.from({ length: 12 }, (_, i) => ({
    id: `pool-${String(i).padStart(2, "0")}`,
    windows: [win("5h", 50), win("1w", 50)],
  }));
  const panel = buildQuotaPanel(
    result("antigravity", pools, { availability: "error" }),
    { ...base, expanded: false },
  );
  const values = panel.keyValues.map((r) => r.value);
  assert.equal(panel.keyValues.length, 24);
  assert.ok(values.includes("OLD (error)"));
  assert.match(values[23], /more rows omitted/);
  assert.equal(panel.rows.length, 24);
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
  assert.match(lines, /w no age · unknown/);
  assert.match(lines, /^x unknown$/m);
  assert.doesNotMatch(lines, /NaN/);
});

test("expanded panel has no duplicate summary but keeps stale and error truth", () => {
  const stale = win("1w", 80, { observedAt: "2026-01-01T10:00:00Z" });
  const panel = buildQuotaPanel(
    result("codex", [{ id: "p", windows: [win("5h", 20), stale] }], {
      availability: "error",
      detail: "boom",
    }),
    base,
  );
  assert.notEqual(panel.keyValues[0].label, "Status");
  assert.equal(panel.keyValues.filter((r) => r.label === "Status").length, 0);
  assert.equal(panel.keyValues[0].label, "State");
  assert.equal(panel.keyValues[0].valueRole, "error");
  // Mixed freshness: provider-level count plus a marker on the stale window.
  assert.match(text(panel).join("\n"), /^ STALE\/UNKNOWN 1\/2$/m);
  assert.match(text(panel).join("\n"), /^1w STALE · 2h 30m$/m);
  assert.match(text(panel).join("\n"), /^5h 2h 30m$/m);
  assert.equal(
    panel.keyValues.filter((r) => r.progress !== undefined).length,
    2,
  );
  const empty = buildQuotaPanel(result("codex", []), base);
  assert.equal(empty.keyValues[0].value, "No quota data reported");
});

test("collapsed panels show both windows, 5h before weekly, without age noise", () => {
  const reversed = result("claude-code", [
    { id: "default", windows: [win("1w", 64), win("5h", 27)] },
  ]);
  const closed = buildQuotaPanel(reversed, { ...base, expanded: false });
  assert.deepEqual(
    closed.keyValues.map((r) => [r.label, r.value]),
    [
      ["5h", "27% left"],
      ["1w", "64% left"],
    ],
  );
  const open = buildQuotaPanel(reversed, base);
  assert.deepEqual(
    open.keyValues.map((r) => [r.label, r.value]),
    [
      ["5h", "2h 30m"],
      ["", "27% left"],
      ["1w", "2h 30m"],
      ["", "64% left"],
    ],
  );
  assert.doesNotMatch(`${closed.rows}${open.rows}`, /observed|STALE|age/);
});

test("pool names are humanized and ordered; windows are ordered per pool", () => {
  const panel = buildQuotaPanel(
    result("antigravity", [
      { id: "gemini-3_pro", windows: [win("1w", 10), win("5h", 90)] },
      { id: "claude-gpt", windows: [win("5h", 50)] },
    ]),
    base,
  );
  const pools = panel.keyValues.filter((r) => r.valueRole === "primary");
  assert.deepEqual(
    pools.map((r) => r.value),
    ["Claude GPT", "Gemini 3 Pro"],
  );
  const labels = panel.keyValues.map((r) => r.label).filter(Boolean);
  assert.deepEqual(labels, ["5h", "5h", "1w"]);
});

test("equally stale windows share one provider warning; unknown ages say so", () => {
  const old = { observedAt: "2026-01-01T10:00:00Z" };
  const panel = buildQuotaPanel(
    result("claude-code", [
      { id: "d", windows: [win("5h", 20, old), win("1w", 40, old)] },
    ]),
    base,
  );
  const lines = text(panel).join("\n");
  assert.equal(lines.match(/STALE/g).length, 1);
  assert.match(lines, /^ STALE · 2h 0m ago$/m);
  assert.match(lines, /^5h 2h 30m$/m);
  const unknown = { observedAt: "nope" };
  const none = buildQuotaPanel(
    result("codex", [
      { id: "d", windows: [win("5h", 20, unknown), win("1w", 40, unknown)] },
    ]),
    base,
  );
  assert.equal(text(none).filter((l) => /AGE UNKNOWN/.test(l)).length, 1);
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
