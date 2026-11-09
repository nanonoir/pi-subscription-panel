const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(
  path.join(__dirname, "../extensions/quota-contracts.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { createQuotaWindow, displayRemainingPercent, SOURCE } = sandbox.exports;

const input = {
  kind: "custom-window",
  observedAt: "2026-01-01T00:00:00Z",
  source: SOURCE.RESPONSE_EVENT,
};

test("missing, non-numeric and non-finite percentages do not create windows", () => {
  for (const value of [undefined, null, "0", NaN, Infinity, -Infinity]) {
    assert.equal(
      createQuotaWindow({ ...input, remainingPercent: value }),
      undefined,
    );
  }
  assert.equal(
    createQuotaWindow({ ...input, remainingPercent: 0 }).remainingPercent,
    0,
  );
});

test("display clamping never changes the raw reported percentage", () => {
  for (const [raw, displayed] of [
    [-4, 0],
    [42.5, 42.5],
    [120, 100],
  ]) {
    const window = createQuotaWindow({ ...input, remainingPercent: raw });
    assert.equal(displayRemainingPercent(window), displayed);
    assert.equal(window.remainingPercent, raw);
    assert.equal(window.kind, "custom-window");
    assert.equal(window.observedAt, input.observedAt);
    assert.equal(window.source, input.source);
  }
});

test("reset is omitted when absent and retained when reported", () => {
  const without = createQuotaWindow({ ...input, remainingPercent: 25 });
  assert.equal(Object.hasOwn(without, "resetsAt"), false);
  const withReset = createQuotaWindow({
    ...input,
    remainingPercent: 25,
    resetsAt: "2026-01-02T00:00:00Z",
  });
  assert.equal(withReset.resetsAt, "2026-01-02T00:00:00Z");
});
