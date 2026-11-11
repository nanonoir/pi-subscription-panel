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
const collapsed = { ...base, expanded: false };
const win = (kind, remainingPercent, extra = {}) => ({
  kind,
  remainingPercent,
  observedAt: "2026-01-01T11:59:00Z",
  source: "response-event",
  resetsAt: "2026-01-01T14:30:00Z",
  ...extra,
});
const result = (pools, extra = {}) => ({
  providerId: "codex",
  availability: "ready",
  pools,
  ...extra,
});
const stale = { observedAt: "2026-01-01T10:00:00Z" };

/** Atelier's progressMeter (sidebar.ts), uncolored. */
function meter(percent, meterWidth) {
  const units = Math.min(
    meterWidth * 8,
    Math.max(percent > 0 ? 1 : 0, Math.round((percent * meterWidth * 8) / 100)),
  );
  const full = Math.floor(units / 8);
  const fraction = units % 8;
  const fill = "█".repeat(full) + (fraction ? "▏▎▍▌▋▊▉"[fraction - 1] : "");
  return fill + "░".repeat(meterWidth - full - (fraction ? 1 : 0));
}

/**
 * Faithful, uncolored copy of labeledRow in node_modules/pi-atelier/src/
 * sidebar.ts with the real pi-tui width helpers. `width` is the panel row
 * width Atelier passes to labeledRow (sidebar content columns).
 */
async function renderRows(panel, width) {
  const { truncateToWidth, visibleWidth } =
    await import("@earendil-works/pi-tui");
  return panel.keyValues.map((row) => {
    const left = truncateToWidth(
      row.label,
      Math.min(12, Math.max(0, width - 8)),
      "…",
    );
    const right = truncateToWidth(
      row.value,
      Math.max(0, width - visibleWidth(left) - 1),
      "…",
    );
    const meterWidth = width - visibleWidth(left) - visibleWidth(right) - 2;
    if (row.progress !== undefined && meterWidth >= 4) {
      return `${left} ${meter(row.progress * 100, meterWidth)} ${right}`;
    }
    return truncateToWidth(
      `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`,
      width,
      "",
    );
  });
}

// truncateToWidth may wrap its ellipsis in SGR resets; widths ignore them.
// eslint-disable-next-line no-control-regex
const plain = (line) => line.replace(/\u001b\[[0-9;]*m/g, "");
const render = async (panel, width) =>
  (await renderRows(panel, width)).map(plain);
// Supported minimum content columns, then the default sidebar size.
const WIDTHS = [22, 28];
const fits = (lines, width) =>
  lines.every((line) => Array.from(line).length <= width);

test("limited reading keeps its meter and no ambiguous standalone row", async () => {
  const panel = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 30)] }]),
    base,
  );
  for (const width of WIDTHS) {
    const lines = await render(panel, width);
    const m = lines[1].match(/^ ([█░▏▎▍▌▋▊▉]+) 30% left$/);
    assert.ok(m, `${width}: ${lines[1]}`);
    assert.equal(m[1], meter(30, width - "30% left".length - 2));
    assert.ok(!lines.some((line) => /limited/i.test(line)));
    assert.ok(fits(lines, width));
  }
  const low = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 5)] }]),
    base,
  );
  assert.equal((await render(low, 22))[2].trim(), "LOW");
});

test("collapsed stale, missing and error are each visible", async () => {
  const panel = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 81, stale)] }], {
      availability: "error",
    }),
    collapsed,
  );
  for (const width of WIDTHS) {
    const lines = await render(panel, width);
    const joined = lines.join("\n");
    assert.match(joined, /^ *STALE · 2h 0m ago *$/m, joined);
    assert.match(joined, /^ *1w missing *$/m, joined);
    assert.match(joined, /^ *OLD \(error\) *$/m, joined);
    assert.doesNotMatch(joined, /…|observed/);
    // The summary keeps its meter and value.
    assert.match(joined, /^5h [█▏▎▍▌▋▊▉░]+ 81% left$/m, joined);
    assert.ok(fits(lines, width));
  }
  const multi = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 20), win("1w", 80, stale)] }], {
      availability: "waiting",
    }),
    collapsed,
  );
  const lines = (await render(multi, 22)).join("\n");
  assert.match(lines, /^ *STALE\/UNKNOWN 1\/2 *$/m);
  assert.match(lines, /^ *OLD \(waiting\) *$/m);
});

test("collapsed multi-pool shows every window with its pool and statuses", async () => {
  const panel = buildQuotaPanel(
    {
      ...result([
        { id: "gemini-pro", windows: [win("5h", 5), win("1w", 60)] },
        { id: "claude", windows: [win("5h", 0), win("1w", 140)] },
      ]),
      providerId: "antigravity",
    },
    collapsed,
  );
  for (const width of WIDTHS) {
    const lines = await render(panel, width);
    const joined = lines.join("\n");
    assert.ok(
      joined.indexOf("Claude") < joined.indexOf("EXHAUSTED") &&
        joined.indexOf("EXHAUSTED") < joined.indexOf("Gemini Pro") &&
        joined.indexOf("Gemini Pro") < joined.indexOf("LOW"),
      joined,
    );
    assert.match(joined, /^1w █+ 100% left$/m, joined);
    assert.match(joined, /^1w [█▏▎▍▌▋▊▉░]+ 60% left$/m, joined);
    assert.match(joined, /^ *CLAMP 140% *$/m, joined);
    assert.ok(fits(lines, width), joined);
  }
});

test("collapsed mixed freshness marks the stale window beside its meter", async () => {
  const panel = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 20), win("1w", 80, stale)] }]),
    collapsed,
  );
  for (const width of WIDTHS) {
    const lines = await render(panel, width);
    const at = lines.findIndex((line) =>
      /^1w [█▏▎▍▌▋▊▉░]+ 80% left$/.test(line),
    );
    assert.ok(at > 0, lines.join("\n"));
    assert.equal(lines[at + 1].trim(), "STALE");
    assert.match(lines.join("\n"), /^5h [█▏▎▍▌▋▊▉░]+ 20% left$/m);
    assert.ok(!lines.some((line) => /^5h .*(STALE|AGE)/.test(line)));
    assert.ok(fits(lines, width));
  }
  const unknown = buildQuotaPanel(
    result([
      { id: "p", windows: [win("5h", 20), win("1w", 80, { observedAt: "x" })] },
    ]),
    collapsed,
  );
  const rows = (await render(unknown, 22)).map((line) => line.trim());
  assert.ok(rows.includes("AGE UNKNOWN"));
});

test("clamped reading keeps qualifier and value, meter stays truthful", async () => {
  const panel = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 140), win("1w", -20)] }]),
    base,
  );
  const short = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 140)] }]),
    collapsed,
  );
  for (const width of WIDTHS) {
    const lines = await render(panel, width);
    const full = lines.findIndex((line) => /100% left/.test(line));
    assert.ok(full > 0, lines.join("\n"));
    assert.ok(!/…/.test(lines[full]));
    assert.match(lines[full], /^ █+ 100% left$/);
    assert.equal(lines[full + 1].trim(), "CLAMP 140%");
    const empty = lines.findIndex((line) => /^ ░+ 0% left$/.test(line));
    assert.ok(empty > full, lines.join("\n"));
    assert.equal(lines[empty + 1].trim(), "EXHAUSTED");
    assert.equal(lines[empty + 2].trim(), "CLAMP -20%");
    assert.ok(fits(lines, width));
    const collapsedLines = (await render(short, width)).join("\n");
    assert.match(collapsedLines, /^ *CLAMP 140% *$/m);
    assert.match(collapsedLines, /^5h █+ 100% left$/m);
  }
  assert.equal(panel.keyValues[1].progress, 1);
});

test("expanded stale window leads with STALE at minimum width", async () => {
  const panel = buildQuotaPanel(
    result([{ id: "p", windows: [win("5h", 81, stale)] }]),
    base,
  );
  for (const width of WIDTHS) {
    const lines = await render(panel, width);
    // One provider-level warning leads; the window itself is not repeated.
    assert.match(lines[0], /^ *STALE · 2h 0m ago$/, lines[0]);
    assert.match(lines[1], /^5h +2h 30m$/, lines[1]);
    assert.match(lines.join("\n"), /1w missing/);
    assert.ok(fits(lines, width));
  }
});
