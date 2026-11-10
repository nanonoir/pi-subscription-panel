import {
  AVAILABILITY,
  PROVIDER,
  SOURCE,
  type ProviderId,
  type QuotaPool,
  type QuotaResult,
  type QuotaWindow,
} from "./quota-contracts.ts";

// Scheduler-facing result of one poll attempt. It is derived from a
// presentation `QuotaResult` plus transport metadata, without I/O or clocks.

export const POLL_OUTCOME = {
  SUCCESS: "success",
  FAILURE: "failure",
  CANCELLED: "cancelled",
} as const;

export const POLL_FAILURE = {
  AUTHENTICATION: "authentication",
  RATE_LIMIT: "rate-limit",
  RECOVERABLE: "recoverable",
  MANUAL: "manual",
} as const;

export type PollFailureKind = (typeof POLL_FAILURE)[keyof typeof POLL_FAILURE];

/** Claude Code is response-driven and never polled. */
export type PollingProviderId = Exclude<
  ProviderId,
  typeof PROVIDER.CLAUDE_CODE
>;

/** Facts the transport knows without parsing human text. */
export interface PollMetadata {
  httpStatus?: number;
  authUnavailable?: boolean;
  requireManualRetry?: boolean;
  cancelled?: boolean;
  /** Absolute epoch milliseconds of a known server deadline. */
  retryAtMs?: number;
}

export interface PollSuccess {
  kind: typeof POLL_OUTCOME.SUCCESS;
  providerId: PollingProviderId;
  result: QuotaResult;
}

/** Carries no windows: a failure can never refresh observation timestamps. */
export interface PollFailure {
  kind: typeof POLL_OUTCOME.FAILURE;
  providerId: PollingProviderId;
  failure: PollFailureKind;
  detail: string;
  status?: number;
  retryAtMs?: number;
}

export interface PollCancelled {
  kind: typeof POLL_OUTCOME.CANCELLED;
  providerId: PollingProviderId;
}

export type PollOutcome = PollSuccess | PollFailure | PollCancelled;

const MAX_DETAIL_LENGTH = 200;
const GENERIC_DETAIL: Record<PollFailureKind, string> = {
  [POLL_FAILURE.AUTHENTICATION]: "Authentication unavailable or rejected.",
  [POLL_FAILURE.RATE_LIMIT]: "Quota read was rate limited.",
  [POLL_FAILURE.RECOVERABLE]: "Quota read failed.",
  [POLL_FAILURE.MANUAL]: "Quota read failed; manual retry required.",
};
const SOURCES: readonly string[] = Object.values(SOURCE);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Rebuild a window from whitelisted fields, or undefined when invalid. */
function sanitizeWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, remainingPercent, observedAt, source, resetsAt } = value;
  if (
    typeof kind !== "string" ||
    typeof remainingPercent !== "number" ||
    !Number.isFinite(remainingPercent) ||
    typeof observedAt !== "string" ||
    parseTime(observedAt) === undefined ||
    typeof source !== "string" ||
    !SOURCES.includes(source)
  ) {
    return undefined;
  }
  if (resetsAt !== undefined && parseTime(resetsAt) === undefined) {
    return undefined;
  }
  return {
    kind,
    remainingPercent,
    observedAt,
    source: source as QuotaWindow["source"],
    ...(resetsAt === undefined ? {} : { resetsAt: resetsAt as string }),
  };
}

/**
 * Keep only valid windows; any invalid reported window rejects the whole
 * result. Absent windows are legitimate partial data, but at least one valid
 * window is required.
 */
function sanitizePools(value: unknown): QuotaPool[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pools: QuotaPool[] = [];
  let count = 0;
  for (const pool of value as unknown[]) {
    if (
      !isRecord(pool) ||
      typeof pool.id !== "string" ||
      !Array.isArray(pool.windows)
    ) {
      return undefined;
    }
    const windows: QuotaWindow[] = [];
    for (const raw of pool.windows as unknown[]) {
      const window = sanitizeWindow(raw);
      if (window === undefined) return undefined;
      windows.push(window);
    }
    count += windows.length;
    pools.push({ id: pool.id, windows });
  }
  return count > 0 ? pools : undefined;
}

function validStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function safeDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_DETAIL_LENGTH);
}

function latestDeadline(...values: unknown[]): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (latest === undefined || value > latest) latest = value;
  }
  return latest;
}

/** Convert a quota result and transport facts into a scheduler outcome. */
export function toPollOutcome(
  providerId: PollingProviderId,
  result: QuotaResult,
  meta: PollMetadata = {},
): PollOutcome {
  if (meta.cancelled === true) {
    return { kind: POLL_OUTCOME.CANCELLED, providerId };
  }

  const matches = isRecord(result) && result.providerId === providerId;
  const pools =
    matches && result.availability === AVAILABILITY.READY
      ? sanitizePools(result.pools)
      : undefined;
  const status = validStatus(meta.httpStatus);
  const knownFailure =
    meta.authUnavailable === true || (status !== undefined && status >= 400);

  if (pools !== undefined && !knownFailure) {
    return {
      kind: POLL_OUTCOME.SUCCESS,
      providerId,
      result: { providerId, availability: AVAILABILITY.READY, pools },
    };
  }

  let failure: PollFailureKind = POLL_FAILURE.RECOVERABLE;
  if (meta.authUnavailable === true || status === 401 || status === 403) {
    failure = POLL_FAILURE.AUTHENTICATION;
  } else if (status === 429) {
    failure = POLL_FAILURE.RATE_LIMIT;
  } else if (meta.requireManualRetry === true) {
    failure = POLL_FAILURE.MANUAL;
  }

  return {
    kind: POLL_OUTCOME.FAILURE,
    providerId,
    failure,
    detail: (matches && safeDetail(result.detail)) || GENERIC_DETAIL[failure],
    ...(status === undefined ? {} : { status }),
    ...retryDeadline(meta, matches ? result : undefined),
  };
}

function retryDeadline(
  meta: PollMetadata,
  result: QuotaResult | undefined,
): { retryAtMs?: number } {
  const retryAtMs = latestDeadline(meta.retryAtMs, parseTime(result?.retryAt));
  return retryAtMs === undefined ? {} : { retryAtMs };
}
