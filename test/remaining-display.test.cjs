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
const mocks = {
  "./quota-contracts.ts": contracts,
  "./quota-format.ts": format,
};
const { buildQuotaPanel } = load("quota-presentation", mocks);
const { toQuotaResult } = load("legacy-quota", mocks);
const { createClaudeAdapter, parseAntigravity } = load(
  "provider-adapters",
  mocks,
);

const received = Date.parse("2026-01-01T12:00:00Z");
const options = {
  expanded: true,
  displayUsed: false,
  now: received,
  staleAfterMs: 180_000,
};
const bars = (panel) =>
  panel.keyValues.filter((row) => row.progress !== undefined);

test("Codex used percentage renders as remaining with a matching bar", () => {
  const result = toQuotaResult(
    "codex",
    {
      fiveHour: { usedPercent: 19, resetsAt: received + 3_600_000 },
      weekly: { usedPercent: 40 },
    },
    received,
    "http-poll",
  );
  const panel = buildQuotaPanel(result, options);
  const [five, week] = bars(panel);
  assert.equal(five.value, "81% left");
  assert.equal(five.progress, 0.81);
  assert.equal(week.value, "60% left");
  assert.equal(week.progress, 0.6);
  // A legacy saved "used" preference must not flip the display.
  const saved = bars(
    buildQuotaPanel(result, { ...options, displayUsed: true }),
  );
  assert.equal(saved[0].value, "81% left");
  assert.equal(saved[0].progress, 0.81);
});

test("Claude utilization fractions render as remaining", () => {
  const observed = adapterResult(0.25, 0.9);
  const [five, week] = bars(buildQuotaPanel(observed, options));
  assert.equal(five.value, "75% left");
  assert.equal(five.progress, 0.75);
  assert.equal(week.value, "10% left");
  assert.equal(week.progress, 0.1);
});

function adapterResult(fiveHour, sevenDay) {
  return createClaudeAdapter().observeResponse({
    message: {
      role: "assistant",
      provider: "claude-code",
      diagnostics: [
        {
          type: "claude-code.rate-limit",
          timestamp: received,
          details: {
            unifiedWindows: {
              five_hour: { utilization: fiveHour, resetsAt: received / 1000 },
              seven_day: { utilization: sevenDay },
            },
          },
        },
      ],
    },
  });
}

test("Antigravity remaining fractions stay remaining, one block per pool", () => {
  const result = parseAntigravity(
    {
      event: "result",
      result: {
        status: "SUCCESS",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "A",
                buckets: [{ window: "5h", remaining_fraction: 0.5 }],
              },
              {
                name: "B",
                buckets: [{ window: "5h", remaining_fraction: 0.2 }],
              },
            ],
          },
        },
      },
    },
    new Date(received).toISOString(),
  );
  const panel = buildQuotaPanel(result, options);
  assert.deepEqual(
    bars(panel).map((row) => [row.value.replace(/ ·.*/, ""), row.progress]),
    [
      ["50% left", 0.5],
      ["20% left", 0.2],
    ],
  );
  assert.equal(
    panel.keyValues.filter((row) => row.valueRole === "primary").length,
    2,
  );
});
