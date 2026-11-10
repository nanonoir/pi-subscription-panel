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
const f = load("quota-format");

const now = Date.parse("2026-01-01T12:00:00Z");
const opts = { now, staleAfterMs: 180_000 };
const win = (observedAt) => ({ kind: "w", remainingPercent: 50, observedAt });

test("clean strips escapes, control and bidi characters and bounds length", () => {
  assert.equal(f.clean("a\u001b[31mb\n‮c", 20), "a b c");
  assert.equal(f.clean(undefined, 5), "");
  assert.equal(f.clean("abcdef", 4), "abc…");
});

test("parseTime and duration are explicit about invalid input", () => {
  assert.equal(f.parseTime("nope"), undefined);
  assert.equal(f.parseTime(undefined), undefined);
  assert.equal(f.parseTime("2026-01-01T12:00:00Z"), now);
  assert.equal(f.duration(30_000), "<1m");
  assert.equal(f.duration(150 * 60_000), "2h 30m");
  assert.equal(f.duration(26 * 3_600_000), "1d 2h");
});

test("countdown reports due, remaining and unknown resets", () => {
  assert.equal(f.countdown("2026-01-01T14:30:00Z", now), "resets in 2h 30m");
  assert.equal(f.countdown("2026-01-01T11:00:00Z", now), "reset due");
  assert.equal(f.countdown("nope", now), "reset unknown");
  assert.equal(
    f.countdown("2026-01-01T14:30:00Z", Number.NaN),
    "reset unknown",
  );
});

test("stale, age and unknown-freshness criteria", () => {
  const fresh = win("2026-01-01T11:59:00Z");
  const old = win("2026-01-01T10:00:00Z");
  const bad = win("nope");
  assert.equal(f.isStale(fresh, opts), false);
  assert.equal(f.isStale(old, opts), true);
  assert.equal(f.isStale(old, { now, staleAfterMs: Number.NaN }), false);
  assert.equal(f.age(fresh, opts), "observed 1m ago");
  assert.equal(f.age(old, opts), "observed 2h 0m ago · STALE");
  assert.equal(f.age(bad, opts), "age unknown");
  assert.equal(f.isStaleOrUnknown(fresh, opts), false);
  assert.equal(f.isStaleOrUnknown(old, opts), true);
  assert.equal(f.isStaleOrUnknown(bad, opts), true);
  assert.equal(f.isStaleOrUnknown(fresh, { ...opts, now: Number.NaN }), true);
});
