import {
  AVAILABILITY,
  CAPABILITY,
  PROVIDER,
  SOURCE,
  createQuotaWindow,
  type ClaudeCodeAdapter,
  type ProviderId,
  type QuotaResult,
  type QuotaWindow,
} from "./quota-contracts.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const date = (value: number): string | undefined =>
  Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString()
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

export function createClaudeAdapter(): ClaudeCodeAdapter {
  return {
    providerId: PROVIDER.CLAUDE_CODE,
    capability: CAPABILITY.RESPONSE_DRIVEN,
    observeResponse(metadata) {
      const message = object(object(metadata)?.message);
      if (
        message?.role !== "assistant" ||
        message.provider !== PROVIDER.CLAUDE_CODE ||
        !Array.isArray(message.diagnostics)
      )
        return undefined;
      const windows = new Map<string, QuotaWindow>();
      for (const entry of message.diagnostics) {
        const diagnostic = object(entry);
        if (
          diagnostic?.type !== "claude-code.rate-limit" ||
          typeof diagnostic.timestamp !== "number"
        )
          continue;
        const observedAt = date(diagnostic.timestamp);
        const aggregate = object(object(diagnostic.details)?.unifiedWindows);
        if (!observedAt || !aggregate) continue;
        for (const [key, kind] of [
          ["five_hour", "5h"],
          ["seven_day", "1w"],
        ]) {
          const item = object(aggregate[key]);
          if (typeof item?.utilization !== "number") continue;
          const resetsAt =
            typeof item.resetsAt === "number"
              ? date(item.resetsAt * 1000)
              : undefined;
          const window = createQuotaWindow({
            kind,
            remainingPercent: 100 - item.utilization * 100,
            observedAt,
            source: SOURCE.RESPONSE_EVENT,
            resetsAt,
          });
          const previous = windows.get(kind);
          if (window && (!previous || previous.observedAt < observedAt))
            windows.set(kind, window);
        }
      }
      return windows.size
        ? {
            providerId: PROVIDER.CLAUDE_CODE,
            availability: AVAILABILITY.READY,
            pools: [{ id: "default", windows: [...windows.values()] }],
          }
        : undefined;
    },
  };
}

export function waitingState(providerId: ProviderId): QuotaResult {
  return { providerId, availability: AVAILABILITY.WAITING, pools: [] };
}

export function mergeObservation(
  state: QuotaResult,
  update: QuotaResult | undefined,
): QuotaResult {
  if (!update || state.providerId !== update.providerId) return state;
  const pools = state.pools.map((pool) => ({
    ...pool,
    windows: pool.windows.map((window) => ({ ...window })),
  }));
  let accepted = false;
  for (const incoming of update.pools) {
    let pool = pools.find((item) => item.id === incoming.id);
    for (const window of incoming.windows) {
      if (
        !Number.isFinite(Date.parse(window.observedAt)) ||
        !Number.isFinite(window.remainingPercent)
      )
        continue;
      const previous = pool?.windows.find((item) => item.kind === window.kind);
      if (
        previous &&
        Date.parse(previous.observedAt) >= Date.parse(window.observedAt)
      )
        continue;
      if (!pool) {
        pool = { id: incoming.id, windows: [] };
        pools.push(pool);
      }
      pool.windows = pool.windows.filter((item) => item.kind !== window.kind);
      pool.windows.push({ ...window });
      accepted = true;
    }
  }
  if (update.availability === AVAILABILITY.READY && !accepted) return state;
  return { ...update, pools };
}

export function projectAge(
  window: QuotaWindow,
  now: number,
  staleAfterMs: number,
): { ageMs: number; stale: boolean } {
  const ageMs = Math.max(0, now - Date.parse(window.observedAt));
  return { ageMs, stale: ageMs >= staleAfterMs };
}

export function parseAntigravity(
  input: unknown,
  observedAt: string,
): QuotaResult | undefined {
  let payload = object(input);
  if (payload?.event !== undefined)
    payload = payload.event === "result" ? object(payload.result) : undefined;
  if (
    !payload ||
    (payload.status !== undefined &&
      payload.status !== "SUCCESS" &&
      payload.status !== "OK") ||
    !Number.isFinite(Date.parse(observedAt))
  )
    return undefined;
  const command = object(payload.command);
  const groups = object(command?.data)?.groups;
  if (command?.name !== "usage" || !Array.isArray(groups) || !groups.length)
    return undefined;
  const pools: QuotaResult["pools"] = [];
  const identities = new Set<string>();
  for (const value of groups) {
    const group = object(value);
    const id = text(group?.id) ?? text(group?.name);
    if (
      !id ||
      identities.has(id) ||
      !Array.isArray(group?.buckets) ||
      !group.buckets.length
    )
      return undefined;
    identities.add(id);
    const windows: QuotaWindow[] = [];
    const kinds = new Set<string>();
    for (const entry of group.buckets) {
      const bucket = object(entry);
      const rawKind = text(bucket?.window);
      const kind = rawKind === "weekly" ? "1w" : rawKind;
      if (
        !kind ||
        kinds.has(kind) ||
        typeof bucket?.remaining_fraction !== "number"
      )
        return undefined;
      kinds.add(kind);
      const reset = text(bucket.reset_time);
      const resetMs = reset ? Date.parse(reset) : NaN;
      const window = createQuotaWindow({
        kind,
        remainingPercent: bucket.remaining_fraction * 100,
        observedAt,
        source: SOURCE.OFFICIAL_CLI,
        resetsAt: Number.isFinite(resetMs)
          ? new Date(resetMs).toISOString()
          : undefined,
      });
      if (!window) return undefined;
      windows.push(window);
    }
    pools.push({ id, windows });
  }
  return {
    providerId: PROVIDER.ANTIGRAVITY,
    availability: AVAILABILITY.READY,
    pools,
  };
}
