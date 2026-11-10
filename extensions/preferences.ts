import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROVIDER, type ProviderId } from "./quota-contracts.ts";

export const PREFERENCES_FILENAME = "subscription-panel.json";
export const PREFERENCES_SCHEMA_VERSION = 1;

export const DISPLAY_MODE = { REMAINING: "remaining", USED: "used" } as const;
export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];

export const ANTIGRAVITY_MODE = { OFF: "off", AUTO: "auto" } as const;
export type AntigravityMode =
  (typeof ANTIGRAVITY_MODE)[keyof typeof ANTIGRAVITY_MODE];

export const WARNING = {
  MALFORMED: "malformed",
  UNREADABLE: "unreadable",
  FUTURE_SCHEMA: "future-schema",
  WRITE_FAILED: "write-failed",
} as const;
export type WarningCode = (typeof WARNING)[keyof typeof WARNING];

/** Messages are generic on purpose: no file content, paths or error text. */
export interface PreferenceWarning {
  code: WarningCode;
  message: string;
}

const MESSAGES: Record<WarningCode, string> = {
  [WARNING.MALFORMED]:
    "Preferences file is not valid; using defaults and leaving it unchanged.",
  [WARNING.UNREADABLE]:
    "Preferences file could not be read; using defaults and leaving it unchanged.",
  [WARNING.FUTURE_SCHEMA]:
    "Preferences file uses a newer schema; using defaults and leaving it unchanged.",
  [WARNING.WRITE_FAILED]: "Preferences could not be saved.",
};

export interface AntigravityRefresh {
  mode: AntigravityMode;
  activeSeconds: number;
  idleSeconds: number;
}

/** Claude Code is only ever updated from provider responses, never polled. */
export interface ClaudeRefresh {
  mode: "response-event";
}

export interface RefreshPreferences {
  codexSeconds: number;
  claude: ClaudeRefresh;
  antigravity: AntigravityRefresh;
  /**
   * Whether a collapsed provider panel keeps refreshing. Independent of the
   * rendering preference itself; pausing never clears backoff or blocks.
   */
  whileCollapsed: boolean;
}

export interface SubscriptionPreferences {
  displayMode: DisplayMode;
  /** Known provider IDs (including optional native Anthropic); [] = all collapsed. */
  expandedProviders: ProviderId[];
  refresh: RefreshPreferences;
  /** Local observation-age threshold for stale labels; never a poll interval. */
  staleAfterSeconds: number;
}

export interface PreferencesLoadResult {
  preferences: SubscriptionPreferences;
  /** True when the stored file must not be replaced (malformed/unreadable/future). */
  readOnly: boolean;
  warnings: PreferenceWarning[];
}

export interface PreferencesSaveResult {
  saved: boolean;
  warnings: PreferenceWarning[];
}

export interface PreferencesFileOptions {
  /** Overrides the default `<agent dir>/subscription-panel.json` (tests). */
  path?: string;
}

const KNOWN_PROVIDERS: readonly ProviderId[] = Object.values(PROVIDER);

export function defaultPreferences(): SubscriptionPreferences {
  return {
    displayMode: DISPLAY_MODE.REMAINING,
    expandedProviders: [...KNOWN_PROVIDERS],
    refresh: {
      codexSeconds: 60,
      claude: { mode: "response-event" },
      antigravity: {
        mode: ANTIGRAVITY_MODE.OFF,
        activeSeconds: 180,
        idleSeconds: 1200,
      },
      whileCollapsed: true,
    },
    staleAfterSeconds: 180,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Non-integers and unsafe numbers fall back; valid ones are raised to `min`. */
function interval(value: unknown, fallback: number, min: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.max(min, value)
    : fallback;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.find((item) => item === value) ?? fallback;
}

function providers(value: unknown, fallback: ProviderId[]): ProviderId[] {
  if (!Array.isArray(value)) return fallback;
  // Unknown IDs are ignored and duplicates dropped; [] stays "all collapsed".
  return KNOWN_PROVIDERS.filter((id) => value.includes(id));
}

/**
 * Builds valid preferences from an untrusted value. Every field falls back to
 * its default independently; unknown keys are dropped (schema 1 has no legacy
 * keys to preserve, so only known keys are ever serialized).
 */
export function normalizePreferences(raw: unknown): SubscriptionPreferences {
  const defaults = defaultPreferences();
  const input = record(raw);
  const refresh = record(input.refresh);
  const antigravity = record(refresh.antigravity);
  const base = defaults.refresh.antigravity;
  return {
    displayMode: oneOf(
      input.displayMode,
      Object.values(DISPLAY_MODE),
      defaults.displayMode,
    ),
    expandedProviders: providers(
      input.expandedProviders,
      defaults.expandedProviders,
    ),
    refresh: {
      codexSeconds: interval(
        refresh.codexSeconds,
        defaults.refresh.codexSeconds,
        60,
      ),
      // Any stored Claude mode is ignored: Claude Code is never polled.
      claude: { mode: "response-event" },
      antigravity: {
        mode: oneOf(
          antigravity.mode,
          Object.values(ANTIGRAVITY_MODE),
          base.mode,
        ),
        activeSeconds: interval(
          antigravity.activeSeconds,
          base.activeSeconds,
          180,
        ),
        idleSeconds: interval(antigravity.idleSeconds, base.idleSeconds, 1200),
      },
      whileCollapsed:
        typeof refresh.whileCollapsed === "boolean"
          ? refresh.whileCollapsed
          : defaults.refresh.whileCollapsed,
    },
    staleAfterSeconds: interval(
      input.staleAfterSeconds,
      defaults.staleAfterSeconds,
      60,
    ),
  };
}

function warning(code: WarningCode): PreferenceWarning {
  return { code, message: MESSAGES[code] };
}

function resolvePath(options: PreferencesFileOptions): string {
  return options.path ?? join(getAgentDir(), PREFERENCES_FILENAME);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Reads preferences without ever writing. A missing file yields writable
 * defaults. A missing `schemaVersion` is treated as the compatible legacy v1
 * layout (no earlier stored schema is known). Malformed, unreadable or
 * future-schema files yield defaults but are flagged read-only so a later save
 * cannot clobber them.
 */
export async function loadPreferences(
  options: PreferencesFileOptions = {},
): Promise<PreferencesLoadResult> {
  const defaults = defaultPreferences();
  const blocked = (code: WarningCode): PreferencesLoadResult => ({
    preferences: defaults,
    readOnly: true,
    warnings: [warning(code)],
  });

  let text: string;
  try {
    text = await readFile(resolvePath(options), "utf8");
  } catch (error) {
    return isMissing(error)
      ? { preferences: defaults, readOnly: false, warnings: [] }
      : blocked(WARNING.UNREADABLE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return blocked(WARNING.MALFORMED);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return blocked(WARNING.MALFORMED);

  const version = (parsed as Record<string, unknown>).schemaVersion;
  if (version !== undefined) {
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    )
      return blocked(WARNING.MALFORMED);
    if (version > PREFERENCES_SCHEMA_VERSION)
      return blocked(WARNING.FUTURE_SCHEMA);
  }
  return {
    preferences: normalizePreferences(parsed),
    readOnly: false,
    warnings: [],
  };
}

/**
 * Persists preferences only on explicit request. Re-checks the stored file
 * first and refuses to replace malformed, unreadable or future-schema content.
 * Writes an exclusive 0600 temp file next to the target and renames it into
 * place; the temp file is removed on failure. The check and rename are not
 * atomic together; cross-session coordination is out of scope.
 */
export async function savePreferences(
  preferences: SubscriptionPreferences,
  options: PreferencesFileOptions = {},
): Promise<PreferencesSaveResult> {
  const current = await loadPreferences(options);
  if (current.readOnly) return { saved: false, warnings: current.warnings };

  const target = resolvePath(options);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify(
    {
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      ...normalizePreferences(preferences),
    },
    null,
    2,
  )}\n`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, body, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
    return { saved: true, warnings: [] };
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    return { saved: false, warnings: [warning(WARNING.WRITE_FAILED)] };
  }
}
