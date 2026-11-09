import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { registerSidebarPanel } from "pi-atelier/extensions/index.ts";

type UsageWindow = {
  usedPercent: number;
  resetsAt?: number;
};

type ParsedCodexWindow = {
  window: UsageWindow;
  durationSeconds?: number;
};

type ProviderUsage = {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  error?: string;
  windowErrors?: { fiveHour?: string; weekly?: string };
  retryAt?: number;
};

type UsageSnapshot = {
  codex: ProviderUsage;
  claude: ProviderUsage;
};

type JsonRecord = Record<string, unknown>;
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLAUDE_REFRESH_INTERVAL_MS = 30 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const PANEL_ID = "subscription:limits" as const;
const PANEL_SOURCE = "subscription-limits";

class UsageHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexWindow(value: unknown): ParsedCodexWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent =
    value.used_percent ??
    value.usedPercent ??
    value.percent ??
    value.usage_percent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent))
    return undefined;

  const resetAt =
    value.resets_at ?? value.resetsAt ?? value.reset_at ?? value.resetAt;
  const resetAfterSeconds =
    value.reset_after_seconds ??
    value.resetAfterSeconds ??
    value.seconds_until_reset ??
    value.secondsUntilReset;
  const parsedReset =
    typeof resetAt === "number" && Number.isFinite(resetAt)
      ? resetAt * 1000
      : typeof resetAt === "string"
        ? Date.parse(resetAt)
        : typeof resetAfterSeconds === "number" &&
            Number.isFinite(resetAfterSeconds) &&
            resetAfterSeconds >= 0
          ? Date.now() + resetAfterSeconds * 1000
          : undefined;
  const durationSeconds =
    value.window_seconds ??
    value.windowSeconds ??
    value.duration_seconds ??
    value.durationSeconds ??
    value.limit_window_seconds ??
    value.limitWindowSeconds;
  const durationMinutes =
    value.window_minutes ??
    value.windowMinutes ??
    value.duration_minutes ??
    value.durationMinutes;
  const parsedDurationSeconds =
    typeof durationSeconds === "number"
      ? durationSeconds
      : typeof durationMinutes === "number"
        ? durationMinutes * 60
        : undefined;
  return {
    window: {
      usedPercent,
      ...(typeof parsedReset === "number" && Number.isFinite(parsedReset)
        ? { resetsAt: parsedReset }
        : {}),
    },
    ...(typeof parsedDurationSeconds === "number" &&
    Number.isFinite(parsedDurationSeconds)
      ? { durationSeconds: parsedDurationSeconds }
      : {}),
  };
}

function codexWindows(value: unknown): {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
} {
  if (!isRecord(value) && !Array.isArray(value)) return {};
  const record = isRecord(value) ? value : {};
  const rateLimit = isRecord(record.rate_limit) ? record.rate_limit : undefined;
  const primary = rateLimit
    ? parseCodexWindow(rateLimit.primary_window)
    : undefined;
  const secondary = rateLimit
    ? parseCodexWindow(rateLimit.secondary_window)
    : undefined;
  const rawWindows = Array.isArray(value)
    ? value
    : (record.windows ??
      record.usage_windows ??
      record.usageWindows ??
      record.rate_limits ??
      record.rateLimits ??
      record.limits);
  const candidates: ParsedCodexWindow[] = [
    ...(primary ? [primary] : []),
    ...(secondary ? [secondary] : []),
    ...(Array.isArray(rawWindows)
      ? rawWindows.flatMap((entry) => {
          const parsed = parseCodexWindow(entry);
          return parsed ? [parsed] : [];
        })
      : []),
  ];
  const fiveHour =
    candidates.find(
      ({ durationSeconds }) =>
        durationSeconds !== undefined &&
        Math.abs(durationSeconds - 18_000) < 300,
    )?.window ??
    (primary?.durationSeconds === undefined ? primary?.window : undefined);
  const weekly =
    candidates.find(
      ({ durationSeconds }) =>
        durationSeconds !== undefined &&
        Math.abs(durationSeconds - 604_800) < 3_600,
    )?.window ??
    (secondary?.durationSeconds === undefined ? secondary?.window : undefined);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
  };
}

function missingWindowReason(record: JsonRecord, key: string): string {
  if (!Object.hasOwn(record, key)) return `API no incluyó ${key}`;
  if (record[key] === null) return `API devolvió ${key}: null`;
  return `formato ${key} distinto`;
}

function parseCodexUsage(value: unknown): ProviderUsage {
  if (!isRecord(value) && !Array.isArray(value))
    return { error: "respuesta inesperada" };
  const { fiveHour, weekly } = codexWindows(value);
  const rateLimit =
    isRecord(value) && isRecord(value.rate_limit)
      ? value.rate_limit
      : isRecord(value)
        ? value
        : {};
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    windowErrors: {
      ...(!fiveHour
        ? { fiveHour: missingWindowReason(rateLimit, "primary_window") }
        : {}),
      ...(!weekly
        ? { weekly: missingWindowReason(rateLimit, "secondary_window") }
        : {}),
    },
    ...(!fiveHour && !weekly
      ? { error: "ventanas ausentes o formato cambiado" }
      : {}),
  };
}

function parseClaudeWindow(value: unknown): UsageWindow | undefined {
  if (!isRecord(value) || typeof value.utilization !== "number")
    return undefined;
  if (!Number.isFinite(value.utilization)) return undefined;
  if (value.resets_at === null || value.resets_at === undefined)
    return { usedPercent: value.utilization };
  if (typeof value.resets_at !== "string") return undefined;
  const resetsAt = Date.parse(value.resets_at);
  if (!Number.isFinite(resetsAt)) return undefined;
  return { usedPercent: value.utilization, resetsAt };
}

function parseClaudeUsage(value: unknown): ProviderUsage {
  if (!isRecord(value)) return { error: "respuesta inesperada" };
  const fiveHour = parseClaudeWindow(value.five_hour);
  const weekly = parseClaudeWindow(value.seven_day);
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    windowErrors: {
      ...(!fiveHour
        ? { fiveHour: missingWindowReason(value, "five_hour") }
        : {}),
      ...(!weekly ? { weekly: missingWindowReason(value, "seven_day") } : {}),
    },
    ...(!fiveHour && !weekly
      ? { error: "ventanas ausentes o formato cambiado" }
      : {}),
  };
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (!isRecord(decoded)) return undefined;
    const authClaim = decoded["https://api.openai.com/auth"];
    if (!isRecord(authClaim)) return undefined;
    return typeof authClaim.chatgpt_account_id === "string"
      ? authClaim.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function errorLabel(error: unknown): string {
  if (error instanceof UsageHttpError) return `HTTP ${error.status}`;
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "timeout";
  if (error instanceof TypeError) return "error de red";
  return "error de consulta";
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAt =
      retryAfter === null
        ? undefined
        : Number.isFinite(Number(retryAfter))
          ? Date.now() + Math.max(0, Number(retryAfter)) * 1000
          : Date.parse(retryAfter);
    await response.body?.cancel();
    throw new UsageHttpError(
      response.status,
      retryAt !== undefined && Number.isFinite(retryAt) ? retryAt : undefined,
    );
  }
  return response.json();
}

async function readCodexUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  try {
    const providerAuth =
      await ctx.modelRegistry.getProviderAuth("openai-codex");
    const accessToken = providerAuth?.auth.apiKey;
    if (providerAuth?.source !== "OAuth" || !accessToken) {
      const openaiAuth = await ctx.modelRegistry.getProviderAuth("openai");
      return {
        error:
          openaiAuth?.source === "OAuth"
            ? "OAuth openai: cuotas no expuestas"
            : "sin sesión OpenAI Codex",
      };
    }
    const credential = readStoredCredential("openai-codex");
    const accountId =
      credential?.type === "oauth" &&
      typeof credential.accountId === "string" &&
      credential.accountId
        ? credential.accountId
        : accountIdFromAccessToken(accessToken);
    if (!accountId) return { error: "token sin ID de cuenta Codex" };
    const payload = await fetchJson(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
      },
    );
    return parseCodexUsage(payload);
  } catch (error) {
    return usageFailure(error);
  }
}

async function readClaudeUsage(ctx: ExtensionContext): Promise<ProviderUsage> {
  try {
    const providerAuth = await ctx.modelRegistry.getProviderAuth("anthropic");
    const accessToken = providerAuth?.auth.apiKey;
    if (providerAuth?.source !== "OAuth" || !accessToken)
      return { error: "sin sesión OAuth de Anthropic" };
    const payload = await fetchJson(
      "https://api.anthropic.com/api/oauth/usage",
      {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "claude-cli/2.1.75",
        "x-app": "cli",
        Accept: "application/json",
      },
    );
    return parseClaudeUsage(payload);
  } catch (error) {
    return usageFailure(error);
  }
}

function usageFailure(error: unknown): ProviderUsage {
  return {
    error: errorLabel(error),
    ...(error instanceof UsageHttpError && error.status === 429
      ? {
          retryAt: Math.max(
            Date.now() + RATE_LIMIT_BACKOFF_MS,
            error.retryAt ?? 0,
          ),
        }
      : {}),
  };
}

function mergeUsage(
  previous: ProviderUsage,
  update: ProviderUsage,
): ProviderUsage {
  return {
    ...update,
    fiveHour: update.fiveHour ?? previous.fiveHour,
    weekly: update.weekly ?? previous.weekly,
  };
}

function usageFromHeaders(
  headers: Record<string, string>,
  provider: "codex" | "claude",
  now: number,
): ProviderUsage | undefined {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const windows: ProviderUsage = {};
  for (const [name, period] of [
    ["fiveHour", "primary"],
    ["weekly", "secondary"],
  ] as const) {
    const prefix =
      provider === "codex"
        ? `x-codex-${period}`
        : `anthropic-ratelimit-unified-${name === "fiveHour" ? "5h" : "7d"}`;
    const used =
      normalized[
        `${prefix}-${provider === "codex" ? "used-percent" : "utilization"}`
      ];
    if (
      used === undefined ||
      used.trim() === "" ||
      !Number.isFinite(Number(used))
    )
      continue;
    let resetsAt: number | undefined;
    const reset =
      normalized[`${prefix}-${provider === "codex" ? "reset-at" : "reset"}`];
    if (reset !== undefined && reset.trim() !== "") {
      const parsed = Number.isFinite(Number(reset))
        ? Number(reset) * 1000
        : Date.parse(reset);
      if (Number.isFinite(parsed)) resetsAt = parsed;
    }
    if (resetsAt === undefined && provider === "codex") {
      const after = normalized[`${prefix}-reset-after-seconds`];
      if (
        after !== undefined &&
        after.trim() !== "" &&
        Number.isFinite(Number(after)) &&
        Number(after) >= 0
      )
        resetsAt = now + Number(after) * 1000;
    }
    const window: UsageWindow = {
      usedPercent: Number(used) * (provider === "claude" ? 100 : 1),
      resetsAt,
    };
    if (provider === "codex") {
      const minutes = normalized[`${prefix}-window-minutes`];
      if (minutes !== undefined) {
        if (Number(minutes) === 300) windows.fiveHour = window;
        else if (Number(minutes) === 10080) windows.weekly = window;
        continue;
      }
    }
    windows[name] = window;
  }
  return windows.fiveHour || windows.weekly ? windows : undefined;
}

function formatCountdown(resetsAt: number, now: number): string {
  const minutesRemaining = Math.max(0, Math.ceil((resetsAt - now) / 60_000));
  const hours = Math.floor(minutesRemaining / 60);
  const minutes = minutesRemaining % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type PanelKeyValue = {
  label: string;
  value: string;
  labelRole?: "primary" | "muted";
  valueRole: "primary" | "muted" | "input" | "output" | "caution" | "warning";
  progress?: number;
};

function formatWindowRows(
  window: UsageWindow | undefined,
  provider: ProviderUsage,
  period: "5h" | "1w",
  providerRole: "input" | "output",
  now: number,
): PanelKeyValue[] {
  if (!window) {
    const windowName = period === "5h" ? "fiveHour" : "weekly";
    const fallback =
      period === "5h" ? "ventana 5h ausente" : "ventana semanal ausente";
    const error =
      provider.windowErrors?.[windowName] ?? provider.error ?? fallback;
    return [
      {
        label: period,
        value: "n/d",
        labelRole: "muted",
        valueRole: "warning",
        progress: 0,
      },
      { label: "", value: error, valueRole: "warning" },
    ];
  }

  const percent = Math.max(0, window.usedPercent);
  const role =
    percent >= 90 ? "warning" : percent >= 70 ? "caution" : providerRole;
  const reset =
    window.resetsAt === undefined
      ? "reinicio n/d"
      : `reinicio ${formatCountdown(window.resetsAt, now)}`;
  return [
    {
      label: period,
      labelRole: "muted",
      value: `${percent.toFixed(1)}%`,
      valueRole: role,
      progress: Math.min(1, percent / 100),
    },
    { label: "", value: reset, valueRole: "muted" },
    ...(provider.error
      ? [
          {
            label: "",
            value: `dato anterior · ${provider.error}`,
            valueRole: "warning" as const,
          },
        ]
      : []),
  ];
}

function buildPanel(snapshot: UsageSnapshot): {
  id: typeof PANEL_ID;
  title: string;
  role: "context";
  rows: string[];
  keyValues: PanelKeyValue[];
} {
  const now = Date.now();
  const keyValues: PanelKeyValue[] = [
    { label: "Codex", value: "", labelRole: "primary", valueRole: "primary" },
    ...formatWindowRows(
      snapshot.codex.fiveHour,
      snapshot.codex,
      "5h",
      "input",
      now,
    ),
    ...formatWindowRows(
      snapshot.codex.weekly,
      snapshot.codex,
      "1w",
      "input",
      now,
    ),
    { label: "Claude", value: "", labelRole: "primary", valueRole: "primary" },
    ...formatWindowRows(
      snapshot.claude.fiveHour,
      snapshot.claude,
      "5h",
      "output",
      now,
    ),
    ...formatWindowRows(
      snapshot.claude.weekly,
      snapshot.claude,
      "1w",
      "output",
      now,
    ),
  ];
  return {
    id: PANEL_ID,
    title: "Subscription",
    role: "context",
    rows: keyValues.map(({ label, value }) => `${label} ${value}`.trim()),
    keyValues,
  };
}

export default function subscriptionLimitsExtension(pi: ExtensionAPI): void {
  let panel: ReturnType<typeof registerSidebarPanel> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshGeneration = 0;
  let debugNextResponse = false;
  let snapshot: UsageSnapshot = { codex: {}, claude: {} };
  let nextRefresh = { codex: 0, claude: 0 };
  let revisions = { codex: 0, claude: 0 };

  const stop = (): void => {
    debugNextResponse = false;
    refreshGeneration += 1;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    panel?.dispose();
    panel = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    snapshot = {
      codex: { error: "cargando" },
      claude: { error: "cargando" },
    };
    nextRefresh = { codex: 0, claude: 0 };
    revisions = { codex: 0, claude: 0 };
    panel = registerSidebarPanel(pi, buildPanel(snapshot), {
      source: PANEL_SOURCE,
    });
    const generation = refreshGeneration;
    const refresh = async (): Promise<void> => {
      await Promise.all(
        (["codex", "claude"] as const).map(async (provider) => {
          if (Date.now() < nextRefresh[provider]) return;
          const revision = revisions[provider];
          const interval =
            provider === "claude"
              ? CLAUDE_REFRESH_INTERVAL_MS
              : REFRESH_INTERVAL_MS;
          nextRefresh[provider] = Date.now() + interval;
          const update = await (provider === "codex"
            ? readCodexUsage(ctx)
            : readClaudeUsage(ctx));
          if (
            generation !== refreshGeneration ||
            !panel ||
            revision !== revisions[provider]
          )
            return;
          snapshot[provider] = mergeUsage(snapshot[provider], update);
          nextRefresh[provider] = Math.max(
            Date.now() + interval,
            update.retryAt ?? 0,
          );
          panel.update(buildPanel(snapshot));
        }),
      );
      if (generation === refreshGeneration && panel)
        panel.update(buildPanel(snapshot));
    };
    void refresh();
    refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  });

  pi.registerCommand("subscription-debug", {
    description:
      "Inspect quota header names on the next normal provider response",
    handler: async (_args, ctx) => {
      debugNextResponse = true;
      ctx.ui.notify(
        "Diagnóstico preparado para la siguiente respuesta; no se genera ninguna petición adicional.",
        "info",
      );
    },
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (debugNextResponse) {
      debugNextResponse = false;
      const names = Object.keys(event.headers).filter((name) =>
        /quota|rate|limit|usage|reset|retry/i.test(name),
      );
      ctx.ui.notify(
        `Subscription debug · proveedor seleccionado: ${ctx.model?.provider ?? "desconocido"} · HTTP ${event.status} · cabeceras de cuota: ${names.join(", ") || "ninguna"}`,
        "info",
      );
    }
    if (!panel) return;
    const now = Date.now();
    for (const provider of ["codex", "claude"] as const) {
      const update = usageFromHeaders(event.headers, provider, now);
      if (!update) continue;
      revisions[provider] += 1;
      snapshot[provider] = mergeUsage(snapshot[provider], update);
      nextRefresh[provider] =
        now +
        (provider === "claude"
          ? CLAUDE_REFRESH_INTERVAL_MS
          : REFRESH_INTERVAL_MS);
    }
    panel.update(buildPanel(snapshot));
  });

  pi.on("session_shutdown", stop);
}
