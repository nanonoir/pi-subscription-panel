import {
  AVAILABILITY,
  CAPABILITY,
  PROVIDER,
  SOURCE,
  type ClaudeCodeAdapter,
  type PollingAdapter,
  type QuotaAdapter,
  type QuotaPool,
  type QuotaResult,
  type QuotaWindow,
} from "../extensions/quota-contracts.ts";

const claude: ClaudeCodeAdapter = {
  providerId: PROVIDER.CLAUDE_CODE,
  capability: CAPABILITY.RESPONSE_DRIVEN,
  observeResponse: () => undefined,
};
// @ts-expect-error Claude Code has no polling method.
claude.refresh();

// A typed consumer passes untrusted metadata and receives an optional result.
function consumeResponse(
  adapter: ClaudeCodeAdapter,
  metadata: unknown,
): QuotaResult | undefined {
  return adapter.observeResponse(metadata);
}
const observed: QuotaResult | undefined = consumeResponse(claude, {
  headers: {},
});
// @ts-expect-error Result is optional; absence must be handled.
const observedPools: QuotaPool[] = observed.pools;

const invalidClaude: ClaudeCodeAdapter = {
  providerId: PROVIDER.CLAUDE_CODE,
  capability: CAPABILITY.RESPONSE_DRIVEN,
  observeResponse: () => undefined,
  // @ts-expect-error Polling is not a Claude Code capability.
  refresh: async () => ({}),
};

// @ts-expect-error Each window requires its own observation time and source.
const missingObservation: QuotaWindow = { kind: "5h", remainingPercent: 50 };
// @ts-expect-error Source is required even when the observation time is known.
const missingSource: QuotaWindow = {
  kind: "1w",
  remainingPercent: 30,
  observedAt: "now",
};

const waiting: QuotaResult = {
  providerId: PROVIDER.CLAUDE_CODE,
  availability: AVAILABILITY.WAITING,
  pools: [],
};
// @ts-expect-error Polling adapters must explicitly implement refresh.
const missingRefresh: PollingAdapter = {
  providerId: PROVIDER.CODEX,
  capability: CAPABILITY.READ_ONLY_POLLING,
};
const invalidPolling: PollingAdapter = {
  // @ts-expect-error Claude Code cannot be a polling adapter.
  providerId: PROVIDER.CLAUDE_CODE,
  capability: CAPABILITY.READ_ONLY_POLLING,
  refresh: async () => waiting,
};
const partial: QuotaResult = {
  providerId: PROVIDER.ANTIGRAVITY,
  availability: AVAILABILITY.READY,
  pools: [
    {
      id: "pool-a",
      windows: [
        {
          kind: "5h",
          remainingPercent: 10,
          observedAt: "earlier",
          source: SOURCE.OFFICIAL_CLI,
        },
      ],
    },
    {
      id: "pool-b",
      windows: [
        {
          kind: "custom",
          remainingPercent: 20,
          observedAt: "later",
          source: SOURCE.RESPONSE_EVENT,
        },
      ],
    },
  ],
};

function useAdapter(adapter: QuotaAdapter): void {
  if (adapter.capability === CAPABILITY.READ_ONLY_POLLING)
    void adapter.refresh();
  else {
    // @ts-expect-error Response-driven adapters cannot be refreshed.
    void adapter.refresh();
  }
}

void [
  observedPools,
  invalidClaude,
  missingRefresh,
  invalidPolling,
  missingObservation,
  missingSource,
  waiting,
  partial,
  useAdapter,
];
