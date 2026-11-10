import type { QuotaWindow } from "./quota-contracts.ts";

/** Caller-supplied clock and freshness threshold; helpers perform no I/O. */
export interface AgeOptions {
  now: number;
  /** Observation age beyond which a reading is labelled stale. */
  staleAfterMs: number;
}

/** Strip terminal escapes, control and bidi characters, then bound the length. */
export function clean(text: unknown, max: number): string {
  const flat = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*\u0007?)/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

export function parseTime(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function countdown(value: string | undefined, now: number): string {
  const time = parseTime(value);
  if (time === undefined || !Number.isFinite(now)) return "reset unknown";
  return time <= now ? "reset due" : `resets in ${duration(time - now)}`;
}

export function isStale(window: QuotaWindow, options: AgeOptions): boolean {
  const observed = parseTime(window.observedAt);
  return (
    observed !== undefined &&
    Number.isFinite(options.staleAfterMs) &&
    options.now - observed > options.staleAfterMs
  );
}

export function age(window: QuotaWindow, options: AgeOptions): string {
  const observed = parseTime(window.observedAt);
  if (observed === undefined || !Number.isFinite(options.now))
    return "age unknown";
  const text = `observed ${duration(Math.max(0, options.now - observed))} ago`;
  return isStale(window, options) ? `${text} · STALE` : text;
}

/** A window whose freshness cannot be vouched for: stale or no usable age. */
export function isStaleOrUnknown(
  window: QuotaWindow,
  options: AgeOptions,
): boolean {
  return (
    parseTime(window.observedAt) === undefined ||
    !Number.isFinite(options.now) ||
    isStale(window, options)
  );
}
