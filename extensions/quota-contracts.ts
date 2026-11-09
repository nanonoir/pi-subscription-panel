export const PROVIDER = {
  CODEX: "codex",
  CLAUDE_CODE: "claude-code",
  ANTIGRAVITY: "antigravity",
  ANTHROPIC: "anthropic",
} as const;

export type ProviderId = (typeof PROVIDER)[keyof typeof PROVIDER];

export const AVAILABILITY = {
  READY: "ready",
  WAITING: "waiting",
  UNAVAILABLE: "unavailable",
  ERROR: "error",
} as const;

export type Availability = (typeof AVAILABILITY)[keyof typeof AVAILABILITY];

export const SOURCE = {
  RESPONSE_EVENT: "response-event",
  OFFICIAL_CLI: "official-cli",
  READ_ONLY_ENDPOINT: "read-only-endpoint",
  LOCAL_CACHE: "local-cache",
} as const;

export type QuotaSource = (typeof SOURCE)[keyof typeof SOURCE];

// Each window carries its own provenance: a partial response must not refresh
// the apparent age or source of another window.
export interface QuotaWindow {
  kind: string;
  remainingPercent: number;
  observedAt: string;
  source: QuotaSource;
  resetsAt?: string;
}

export interface QuotaPool {
  id: string;
  windows: QuotaWindow[];
}

export interface QuotaResult {
  providerId: ProviderId;
  availability: Availability;
  pools: QuotaPool[];
  detail?: string;
  retryAt?: string;
}

export const CAPABILITY = {
  RESPONSE_DRIVEN: "response-driven",
  READ_ONLY_POLLING: "read-only-polling",
} as const;

export interface ClaudeCodeAdapter {
  providerId: typeof PROVIDER.CLAUDE_CODE;
  capability: typeof CAPABILITY.RESPONSE_DRIVEN;
  /** Parse untrusted ordinary-response metadata; undefined when nothing qualifies. */
  observeResponse(metadata: unknown): QuotaResult | undefined;
}

export interface PollingAdapter {
  providerId:
    | typeof PROVIDER.CODEX
    | typeof PROVIDER.ANTIGRAVITY
    | typeof PROVIDER.ANTHROPIC;
  capability: typeof CAPABILITY.READ_ONLY_POLLING;
  refresh(): Promise<QuotaResult>;
}

export type QuotaAdapter = ClaudeCodeAdapter | PollingAdapter;

export interface QuotaWindowInput {
  kind: string;
  remainingPercent: unknown;
  observedAt: string;
  source: QuotaSource;
  resetsAt?: string;
}

/** Reject missing or non-finite percentages without changing reported values. */
export function createQuotaWindow(
  input: QuotaWindowInput,
): QuotaWindow | undefined {
  if (
    typeof input.remainingPercent !== "number" ||
    !Number.isFinite(input.remainingPercent)
  ) {
    return undefined;
  }
  return {
    kind: input.kind,
    remainingPercent: input.remainingPercent,
    observedAt: input.observedAt,
    source: input.source,
    ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
  };
}

/** Clamp a validated reported percentage only at the display boundary. */
export function displayRemainingPercent(window: QuotaWindow): number {
  return Math.max(0, Math.min(100, window.remainingPercent));
}
