import {
  AVAILABILITY,
  createQuotaWindow,
  type ProviderId,
  type QuotaResult,
  type QuotaSource,
  type QuotaWindow,
} from "./quota-contracts.ts";

/** Structural subset of the legacy provider usage this boundary reads. */
export interface LegacyQuotaWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface LegacyQuotaInput {
  fiveHour?: LegacyQuotaWindow;
  weekly?: LegacyQuotaWindow;
  error?: string;
  retryAt?: number;
}

const iso = (epochMs: number | undefined): string | undefined =>
  epochMs !== undefined && Number.isFinite(new Date(epochMs).getTime())
    ? new Date(epochMs).toISOString()
    : undefined;

/** Convert only the windows reported by one legacy update; nothing is invented. */
export function toQuotaResult(
  providerId: ProviderId,
  update: LegacyQuotaInput,
  receivedAt: number,
  source: QuotaSource,
): QuotaResult {
  const windows = (
    [
      ["5h", update.fiveHour],
      ["1w", update.weekly],
    ] as const
  ).flatMap(([kind, window]): QuotaWindow[] => {
    const converted =
      window &&
      createQuotaWindow({
        kind,
        remainingPercent: 100 - window.usedPercent,
        observedAt: new Date(receivedAt).toISOString(),
        source,
        resetsAt: iso(window.resetsAt),
      });
    return converted ? [converted] : [];
  });
  if (windows.length)
    return {
      providerId,
      availability: AVAILABILITY.READY,
      pools: [{ id: "default", windows }],
    };
  const retryAt = iso(update.retryAt);
  return {
    providerId,
    availability: AVAILABILITY.ERROR,
    pools: [],
    detail: update.error ?? "respuesta inesperada",
    ...(retryAt ? { retryAt } : {}),
  };
}
