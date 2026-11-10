const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadRuntime } = require("./helpers/runtime-loader.cjs");

const { toQuotaResult } = loadRuntime({ entry: "legacy-quota" }).entry;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a legacy usage update converts only its reported windows", () => {
  const at = Date.parse("2026-01-01T12:00:00Z");
  const result = toQuotaResult(
    "codex",
    { weekly: { usedPercent: 130, resetsAt: at + 60_000 }, error: "HTTP 429" },
    at,
    "read-only-endpoint",
  );
  assert.deepEqual(plain(result), {
    providerId: "codex",
    availability: "ready",
    pools: [
      {
        id: "default",
        windows: [
          {
            kind: "1w",
            remainingPercent: -30,
            observedAt: "2026-01-01T12:00:00.000Z",
            source: "read-only-endpoint",
            resetsAt: "2026-01-01T12:01:00.000Z",
          },
        ],
      },
    ],
  });
  const failed = toQuotaResult(
    "anthropic",
    { error: "HTTP 429", retryAt: at + 300_000 },
    at,
    "read-only-endpoint",
  );
  assert.deepEqual(plain(failed), {
    providerId: "anthropic",
    availability: "error",
    pools: [],
    detail: "HTTP 429",
    retryAt: "2026-01-01T12:05:00.000Z",
  });
});
