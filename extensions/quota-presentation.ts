import type { registerSidebarPanel } from "pi-atelier/extensions/index.ts";
import {
  AVAILABILITY,
  PROVIDER,
  displayRemainingPercent,
  type ProviderId,
  type QuotaResult,
  type QuotaWindow,
} from "./quota-contracts.ts";
import {
  age,
  clean,
  countdown,
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
  displayUsed: boolean;
}

const MAX_ROWS = 24;
const MAX_ROW_CHARS = 160;
const MAX_LABEL_CHARS = 24;
const MAX_DETAIL_CHARS = 80;

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
  { kind: "5h", note: "Five-hour window not reported" },
  { kind: "1w", note: "Weekly window not reported" },
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

function percentText(window: QuotaWindow, displayUsed: boolean): string {
  const shown = displayRemainingPercent(window);
  const value = displayUsed ? 100 - shown : shown;
  const text = `${Number(value.toFixed(1))}% ${displayUsed ? "used" : "remaining"}`;
  const raw = window.remainingPercent;
  const note =
    raw === shown
      ? ""
      : ` (reported ${Number(raw.toFixed(1))}% remaining, out of range; shown clamped)`;
  const level = shown <= 10 ? " · LOW" : shown <= 30 ? " · limited" : "";
  return `${text}${level}${note}`;
}

function semanticRole(window: QuotaWindow): Role {
  const shown = displayRemainingPercent(window);
  return shown <= 10 ? "warning" : shown <= 30 ? "caution" : "success";
}

function windowRows(
  window: QuotaWindow,
  options: QuotaPanelOptions,
): KeyValue[] {
  const label = clean(window.kind, MAX_LABEL_CHARS) || "window";
  const timing: KeyValue = {
    label: "",
    value: `${countdown(window.resetsAt, options.now)} · ${age(window, options)}`,
    valueRole: isStale(window, options) ? "caution" : "muted",
  };
  if (!hasPercent(window)) {
    return [
      {
        label,
        labelRole: "muted",
        value: "Unavailable (percentage not reported)",
        valueRole: "muted",
      },
      timing,
    ];
  }
  const shown = displayRemainingPercent(window);
  return [
    {
      label,
      labelRole: "muted",
      value: percentText(window, options.displayUsed),
      valueRole: semanticRole(window),
      progress: (options.displayUsed ? 100 - shown : shown) / 100,
    },
    timing,
  ];
}

function noteRow(note: string): KeyValue {
  return { label: "", value: note, valueRole: "muted" };
}

function summary(result: QuotaResult, options: QuotaPanelOptions): KeyValue {
  const pools = result.pools.filter((pool) => pool.windows.length > 0);
  const windows = pools.flatMap((pool) => pool.windows);
  if (windows.length === 0) {
    return {
      label: "Status",
      value: NO_DATA_TEXT[result.availability] ?? "Unavailable",
      valueRole: result.availability === AVAILABILITY.ERROR ? "error" : "muted",
    };
  }
  const prefix =
    result.availability === AVAILABILITY.READY
      ? ""
      : `Old data (${result.availability}) · `;
  const observed = (window: QuotaWindow): number =>
    parseTime(window.observedAt) ?? Number.NEGATIVE_INFINITY;
  const newest = windows.reduce((a, b) => (observed(b) > observed(a) ? b : a));
  const doubtful = windows.filter((w) => isStaleOrUnknown(w, options)).length;
  // Freshness warning leads the row so bounding never truncates it away.
  const warning =
    doubtful === 0
      ? ""
      : windows.length > 1
        ? `STALE/UNKNOWN ${doubtful}/${windows.length} · `
        : `${isStale(windows[0], options) ? "STALE" : "AGE UNKNOWN"} · `;
  const caveats = [
    ...new Set(
      pools.flatMap((pool) =>
        missingNotes(
          result.providerId,
          result.providerId === PROVIDER.ANTIGRAVITY ? pool.windows : windows,
        ),
      ),
    ),
  ];
  const suffix = caveats.map((caveat) => ` · ${caveat}`).join("");
  if (result.pools.length > 1) {
    const empty = result.pools.length - pools.length;
    return {
      label: "Status",
      value: `${warning}${prefix}${result.pools.length} pools${empty > 0 ? ` (${empty} without data)` : ""} · ${age(newest, options)}${suffix}`,
      valueRole: doubtful > 0 ? "caution" : "muted",
    };
  }
  const valid = windows.filter(hasPercent);
  const tightest = (valid.length > 0 ? valid : windows).reduce((a, b) =>
    hasPercent(b) && displayRemainingPercent(b) < displayRemainingPercent(a)
      ? b
      : a,
  );
  const [row] = windowRows(tightest, options);
  return {
    ...row,
    value: `${warning}${prefix}${clean(tightest.kind, MAX_LABEL_CHARS) || "window"} ${row.value} · ${age(tightest, options)}${suffix}`,
    label: "Status",
    labelRole: undefined,
  };
}

function details(result: QuotaResult, options: QuotaPanelOptions): KeyValue[] {
  const rows: KeyValue[] = [];
  if (result.availability !== AVAILABILITY.READY) {
    const detail = clean(result.detail, MAX_DETAIL_CHARS);
    rows.push({
      label: "State",
      value: `${NO_DATA_TEXT[result.availability] ?? "Unavailable"}${detail ? ` · ${detail}` : ""}`,
      valueRole: result.availability === AVAILABILITY.ERROR ? "error" : "muted",
    });
    const retry = parseTime(result.retryAt);
    if (retry !== undefined) {
      rows.push({
        label: "",
        value: `retry ${retry <= options.now ? "due" : `in ${duration(retry - options.now)}`}`,
        valueRole: "muted",
      });
    }
  }
  const labelPools =
    result.pools.length > 1 || result.providerId === PROVIDER.ANTIGRAVITY;
  const perPool = result.providerId === PROVIDER.ANTIGRAVITY;
  for (const pool of result.pools) {
    const empty = pool.windows.length === 0;
    if (labelPools || empty) {
      rows.push({
        label: `Pool ${clean(pool.id, MAX_LABEL_CHARS)}`,
        value: "",
        labelRole: "primary",
      });
    }
    if (empty) {
      const detail = clean(result.detail, MAX_DETAIL_CHARS);
      rows.push(
        noteRow(
          `${NO_DATA_TEXT[result.availability] ?? "Unavailable"}${detail ? ` · ${detail}` : ""}`,
        ),
      );
    }
    for (const window of pool.windows)
      rows.push(...windowRows(window, options));
    if (perPool) {
      for (const note of missingNotes(result.providerId, pool.windows))
        rows.push(noteRow(note));
    }
  }
  if (!perPool) {
    const all = result.pools.flatMap((pool) => pool.windows);
    for (const note of missingNotes(result.providerId, all))
      rows.push(noteRow(note));
  }
  return rows;
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
  const entries = [
    summary(result, options),
    ...(options.expanded ? details(result, options) : []),
  ];
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
