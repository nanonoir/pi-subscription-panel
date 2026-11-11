import type { registerSidebarPanel } from "pi-atelier/extensions/index.ts";
import {
  AVAILABILITY,
  PROVIDER,
  displayRemainingPercent,
  type ProviderId,
  type QuotaPool,
  type QuotaResult,
  type QuotaWindow,
} from "./quota-contracts.ts";
import {
  clean,
  duration,
  isStale,
  isStaleOrUnknown,
  parseTime,
  type AgeOptions,
} from "./quota-format.ts";

type Contribution = Parameters<typeof registerSidebarPanel>[1];
type KeyValue = NonNullable<Contribution["keyValues"]>[number];
type Role = NonNullable<KeyValue["valueRole"]>;

export interface QuotaPanelOptions extends AgeOptions {
  expanded: boolean;
  /**
   * Legacy saved preference, deliberately ignored: the panel always shows what
   * is left. Reconcile the `display` controls and schema in a follow-up.
   */
  displayUsed: boolean;
}

const MAX_ROWS = 24;
const MAX_ROW_CHARS = 160;
const MAX_LABEL_CHARS = 24;
const MAX_DETAIL_CHARS = 80;
const MAX_POOL_NAME_CHARS = 40;

const PANELS: Record<ProviderId, { id: `${string}:${string}`; title: string }> =
  {
    [PROVIDER.CODEX]: { id: "subscription:limits", title: "Codex" },
    [PROVIDER.CLAUDE_CODE]: {
      id: "subscription:claude-code",
      title: "Claude Code",
    },
    [PROVIDER.ANTIGRAVITY]: {
      id: "subscription:antigravity",
      title: "Antigravity",
    },
    [PROVIDER.ANTHROPIC]: {
      id: "subscription:anthropic",
      title: "Native Anthropic",
    },
  };

const NO_DATA_TEXT = {
  [AVAILABILITY.READY]: "No quota data reported",
  [AVAILABILITY.WAITING]: "Waiting for data",
  [AVAILABILITY.UNAVAILABLE]: "Unavailable",
  [AVAILABILITY.ERROR]: "Error",
};

/** Presentation boundary: raw values are never altered, only refused. */
function hasPercent(window: QuotaWindow): boolean {
  return (
    typeof window.remainingPercent === "number" &&
    Number.isFinite(window.remainingPercent)
  );
}

const EXPECTED_WINDOWS = [
  { kind: "5h", note: "5h missing" },
  { kind: "1w", note: "1w missing" },
];

/** Notes for known 5h/1w windows missing from what the provider reported. */
function missingNotes(
  providerId: ProviderId,
  windows: QuotaWindow[],
): string[] {
  const kinds = new Set(windows.map((window) => window.kind));
  if (windows.length === 0) return [];
  // Antigravity pools may carry other kinds; only judge pools that report a
  // known kind, so unknown future kinds are never assumed to be 5h/1w.
  if (
    providerId === PROVIDER.ANTIGRAVITY &&
    !EXPECTED_WINDOWS.some((expected) => kinds.has(expected.kind))
  ) {
    return [];
  }
  return EXPECTED_WINDOWS.filter((expected) => !kinds.has(expected.kind)).map(
    (expected) => expected.note,
  );
}

/** Claude Code has no probe of its own: it fills in on the next response. */
function noDataText(result: QuotaResult): string {
  return result.providerId === PROVIDER.CLAUDE_CODE &&
    result.availability === AVAILABILITY.WAITING
    ? "(waiting refresh)"
    : (NO_DATA_TEXT[result.availability] ?? "Unavailable");
}

/** Time until reset without a label: the window name already gives context. */
function resetText(window: QuotaWindow, now: number): string {
  const time = parseTime(window.resetsAt);
  if (time === undefined || !Number.isFinite(now)) return "unknown";
  return time <= now ? "due" : duration(time - now);
}

function percentText(window: QuotaWindow): string {
  const shown = displayRemainingPercent(window);
  return `${Number(shown.toFixed(1))}% left`;
}

/** Known windows first (5h, then weekly), the rest by name; never input order. */
const WINDOW_ORDER = EXPECTED_WINDOWS.map((expected) => expected.kind);

function windowRank(window: QuotaWindow): number {
  const index = WINDOW_ORDER.indexOf(window.kind);
  return index < 0 ? WINDOW_ORDER.length : index;
}

function sortedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort(
    (a, b) => windowRank(a) - windowRank(b) || a.kind.localeCompare(b.kind),
  );
}

function sortedPools(pools: QuotaPool[]): QuotaPool[] {
  return pools
    .map((pool) => ({ ...pool, windows: sortedWindows(pool.windows) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const ACRONYMS = new Set(["ai", "gpt", "llm"]);

/** `gemini-3_pro` -> `Gemini 3 Pro`; the raw id is only a fallback. */
function poolName(id: string): string {
  const words = clean(id, MAX_POOL_NAME_CHARS)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    );
  return words.join(" ") || "Pool";
}

/** Exhausted/low state as its own compact row, so the meter keeps its room. */
function levelRows(window: QuotaWindow): KeyValue[] {
  if (!hasPercent(window)) return [];
  const shown = displayRemainingPercent(window);
  if (shown <= 0)
    return [{ label: "", value: "EXHAUSTED", valueRole: "error" }];
  if (shown <= 10) return [{ label: "", value: "LOW", valueRole: "warning" }];
  return [];
}

/** Reported value outside 0-100: the meter is clamped, the row says so. */
function isOutOfRange(window: QuotaWindow): boolean {
  return (
    hasPercent(window) &&
    window.remainingPercent !== displayRemainingPercent(window)
  );
}

/** Short separate row so the percent row stays inside narrow sidebars. */
function rangeRow(window: QuotaWindow): KeyValue {
  return {
    label: "",
    value: `CLAMP ${Number(window.remainingPercent.toFixed(1))}%`,
    valueRole: "caution",
  };
}

function semanticRole(window: QuotaWindow): Role {
  const shown = displayRemainingPercent(window);
  return shown <= 10 ? "warning" : shown <= 30 ? "caution" : "success";
}

/** Bar and percentage line; never invents a value that was not reported. */
function percentRow(window: QuotaWindow): KeyValue {
  if (!hasPercent(window)) {
    return {
      label: "",
      value: "Unavailable",
      valueRole: "muted",
    };
  }
  const shown = displayRemainingPercent(window);
  return {
    label: "",
    value: percentText(window),
    valueRole: semanticRole(window),
    progress: shown / 100,
  };
}

interface Freshness {
  /** Provider-level warning; absent when every window is vouched for. */
  rows: KeyValue[];
  /** Windows need their own marker only when freshness differs between them. */
  mark: boolean;
}

/**
 * One compact provider-level freshness warning. Fresh readings show no age; a
 * provider whose windows are all equally doubtful is not repeated per window.
 */
function freshness(windows: QuotaWindow[], options: AgeOptions): Freshness {
  const doubtful = windows.filter((w) => isStaleOrUnknown(w, options));
  if (doubtful.length === 0) return { rows: [], mark: false };
  const stale = doubtful.filter((w) => isStale(w, options));
  const warn = (value: string): Freshness["rows"] => [
    { label: "", value, valueRole: "caution" },
  ];
  if (doubtful.length === windows.length && stale.length === windows.length) {
    const newest = Math.max(
      ...stale.map((w) => parseTime(w.observedAt) ?? Number.NEGATIVE_INFINITY),
    );
    return {
      rows: warn(`STALE · ${duration(Math.max(0, options.now - newest))} ago`),
      mark: false,
    };
  }
  if (doubtful.length === windows.length && stale.length === 0)
    return { rows: warn("AGE UNKNOWN"), mark: false };
  return {
    rows: warn(`STALE/UNKNOWN ${doubtful.length}/${windows.length}`),
    mark: true,
  };
}

/**
 * Same structure for every window: name with reset, then bar with remaining.
 * The compact (collapsed) form keeps only the bar, led by the window name.
 */
function windowRows(
  window: QuotaWindow,
  options: QuotaPanelOptions,
  mark: boolean,
  withReset: boolean,
): KeyValue[] {
  const doubtful = isStaleOrUnknown(window, options);
  const name = clean(window.kind, MAX_LABEL_CHARS) || "window";
  const reset = resetText(window, options.now);
  return [
    ...(withReset
      ? [
          {
            label: name,
            labelRole: "muted" as const,
            // The marker leads so narrow hosts truncate the detail, not it.
            value:
              mark && doubtful
                ? `${isStale(window, options) ? "STALE" : "no age"} · ${reset}`
                : reset,
            valueRole: doubtful ? ("caution" as const) : ("muted" as const),
          },
        ]
      : []),
    {
      ...percentRow(window),
      ...(withReset ? {} : { label: name, labelRole: "muted" as const }),
    },
    ...levelRows(window),
    ...(isOutOfRange(window) ? [rangeRow(window)] : []),
    // Compact form has no reset row to carry the marker; a separate short row
    // keeps the meter intact while still identifying the doubtful window.
    ...(!withReset && mark && doubtful
      ? [cautionRow(isStale(window, options) ? "STALE" : "AGE UNKNOWN")]
      : []),
  ];
}

function noteRow(note: string): KeyValue {
  return { label: "", value: note, valueRole: "muted" };
}

function cautionRow(note: string): KeyValue {
  return { label: "", value: note, valueRole: "caution" };
}

function noDataRow(result: QuotaResult): KeyValue {
  return {
    label: "",
    value: noDataText(result),
    valueRole: result.availability === AVAILABILITY.ERROR ? "error" : "muted",
  };
}

/** Availability detail for a result that is not a clean, current reading. */
function stateRows(
  result: QuotaResult,
  options: QuotaPanelOptions,
): KeyValue[] {
  if (result.availability === AVAILABILITY.READY) return [];
  const detail = clean(result.detail, MAX_DETAIL_CHARS);
  const rows: KeyValue[] = [
    {
      label: "State",
      value: `${noDataText(result)}${detail ? ` · ${detail}` : ""}`,
      valueRole: result.availability === AVAILABILITY.ERROR ? "error" : "muted",
    },
  ];
  const retry = parseTime(result.retryAt);
  if (retry !== undefined) {
    rows.push(
      noteRow(
        `retry ${retry <= options.now ? "due" : `in ${duration(retry - options.now)}`}`,
      ),
    );
  }
  return rows;
}

/** Expanded body: every window with its reset, grouped by readable pool. */
function expandedRows(
  result: QuotaResult,
  pools: QuotaPool[],
  options: QuotaPanelOptions,
  mark: boolean,
): KeyValue[] {
  const rows: KeyValue[] = [];
  const labelPools =
    result.pools.length > 1 || result.providerId === PROVIDER.ANTIGRAVITY;
  const perPool = result.providerId === PROVIDER.ANTIGRAVITY;
  for (const pool of pools) {
    const empty = pool.windows.length === 0;
    if (labelPools || empty) {
      rows.push({
        label: "",
        value: poolName(pool.id),
        valueRole: "primary",
      });
    }
    if (empty) {
      const detail = clean(result.detail, MAX_DETAIL_CHARS);
      rows.push(
        noteRow(`${noDataText(result)}${detail ? ` · ${detail}` : ""}`),
      );
    }
    for (const window of pool.windows)
      rows.push(...windowRows(window, options, mark, true));
    if (perPool) {
      for (const note of missingNotes(result.providerId, pool.windows))
        rows.push(noteRow(note));
    }
  }
  if (!perPool) {
    const all = pools.flatMap((pool) => pool.windows);
    for (const note of missingNotes(result.providerId, all))
      rows.push(noteRow(note));
  }
  return rows;
}

/**
 * Collapsed body: the same windows as compact meters, so a collapsed panel is
 * never mistaken for an incomplete one. Several pools add a count and a name
 * row before each pool's meters.
 */
function collapsedRows(
  result: QuotaResult,
  pools: QuotaPool[],
  options: QuotaPanelOptions,
  mark: boolean,
): KeyValue[] {
  const withData = pools.filter((pool) => pool.windows.length > 0);
  const caveats = [
    ...new Set(
      withData.flatMap((pool) =>
        missingNotes(
          result.providerId,
          result.providerId === PROVIDER.ANTIGRAVITY
            ? pool.windows
            : withData.flatMap((item) => item.windows),
        ),
      ),
    ),
  ];
  const old: KeyValue[] =
    result.availability === AVAILABILITY.READY
      ? []
      : [
          {
            label: "",
            value: `OLD (${result.availability})`,
            valueRole:
              result.availability === AVAILABILITY.ERROR ? "error" : "caution",
          },
        ];
  if (result.pools.length > 1) {
    const empty = result.pools.length - withData.length;
    // Availability leads so the display limit can never drop it.
    return [
      ...old,
      {
        label: "Status",
        value: `${result.pools.length} pools`,
        valueRole: "muted",
      },
      ...(empty > 0 ? [noteRow(`${empty} without data`)] : []),
      ...withData.flatMap((pool) => [
        { label: "", value: poolName(pool.id), valueRole: "primary" as const },
        ...pool.windows.flatMap((window) =>
          windowRows(window, options, mark, false),
        ),
      ]),
      ...caveats.map(cautionRow),
    ];
  }
  return [
    ...old,
    ...withData.flatMap((pool) =>
      pool.windows.flatMap((window) =>
        windowRows(window, options, mark, false),
      ),
    ),
    ...caveats.map(cautionRow),
  ];
}

function bound(row: KeyValue): KeyValue {
  const label = clean(row.label, MAX_LABEL_CHARS);
  const room = MAX_ROW_CHARS - (label ? label.length + 1 : 0);
  return { ...row, label, value: clean(row.value, room) };
}

/** Build a bounded, host-safe sidebar contribution from one provider result. */
export function buildQuotaPanel(
  result: QuotaResult,
  options: QuotaPanelOptions,
): Contribution {
  const identity = PANELS[result.providerId];
  const pools = sortedPools(result.pools);
  const windows = pools.flatMap((pool) => pool.windows);
  const { rows: warnings, mark } = freshness(windows, options);
  const entries: KeyValue[] = [];
  if (windows.length === 0) {
    // Expanded, a non-ready result is described once by its State row.
    if (options.expanded && result.availability !== AVAILABILITY.READY)
      entries.push(
        ...stateRows(result, options),
        ...expandedRows(result, pools, options, mark),
      );
    else {
      entries.push(noDataRow(result));
      if (options.expanded)
        entries.push(...expandedRows(result, pools, options, mark));
    }
  } else if (options.expanded) {
    // Windows carry their own values and the State rows carry availability, so
    // no separate summary precedes them; the freshness warning still leads.
    entries.push(
      ...stateRows(result, options),
      ...warnings,
      ...expandedRows(result, pools, options, mark),
    );
  } else {
    entries.push(...warnings, ...collapsedRows(result, pools, options, mark));
  }
  if (entries.length > MAX_ROWS) {
    const omitted = entries.length - (MAX_ROWS - 1);
    entries.length = MAX_ROWS - 1;
    entries.push({
      label: "",
      value: `… ${omitted} more rows omitted (display limit)`,
      valueRole: "caution",
    });
  }
  const keyValues = entries.map(bound);
  return {
    id: identity.id,
    title: identity.title,
    role: "context",
    rows: keyValues.map(({ label, value }) =>
      clean(`${label} ${value}`, MAX_ROW_CHARS),
    ),
    keyValues,
  };
}
