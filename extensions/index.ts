import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { toQuotaResult } from "./legacy-quota.ts";
import { PROVIDER, SOURCE, type ProviderId } from "./quota-contracts.ts";
import { createSubscriptionPanels } from "./subscription-panels.ts";

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

type JsonRecord = Record<string, unknown>;
const REFRESH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CLAUDE_REFRESH_INTERVAL_MS = 30 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

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
    if (providerAuth?.source !== "OAuth" || !accessToken)
      return { error: "sin sesión de cuota OpenAI Codex" };
    const credential = readStoredCredential("openai-codex");
    // Stored metadata is only trusted when it belongs to the resolved token.
    const accountId =
      accountIdFromAccessToken(accessToken) ??
      (credential?.type === "oauth" &&
      credential.access === accessToken &&
      typeof credential.accountId === "string" &&
      credential.accountId
        ? credential.accountId
        : undefined);
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

const POLLED = [
  { id: PROVIDER.CODEX, read: readCodexUsage, interval: REFRESH_INTERVAL_MS },
  {
    id: PROVIDER.ANTHROPIC,
    read: readClaudeUsage,
    interval: CLAUDE_REFRESH_INTERVAL_MS,
  },
] as const;

export default function subscriptionLimitsExtension(pi: ExtensionAPI): void {
  const controller = createSubscriptionPanels(pi);
  let timer: ReturnType<typeof setInterval> | undefined;
  let live = false;
  let generation = 0;
  let debugNextResponse = false;
  const nextRefresh = new Map<ProviderId, number>();
  const revisions = new Map<ProviderId, number>();

  const stop = (): void => {
    debugNextResponse = false;
    generation += 1;
    live = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    controller.stop();
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    const mine = generation;
    // Passive headers arriving while preferences load are buffered by the
    // controller, so bookkeeping must be live before the await.
    live = true;
    nextRefresh.clear();
    revisions.clear();
    await controller.start(ctx);
    if (mine !== generation) return;
    const refresh = async (): Promise<void> => {
      await Promise.all(
        POLLED.map(async ({ id, read, interval }) => {
          if (Date.now() < (nextRefresh.get(id) ?? 0)) return;
          const revision = revisions.get(id) ?? 0;
          nextRefresh.set(id, Date.now() + interval);
          const update = await read(ctx);
          if (mine !== generation || revision !== (revisions.get(id) ?? 0))
            return;
          const now = Date.now();
          nextRefresh.set(id, Math.max(now + interval, update.retryAt ?? 0));
          controller.update(
            toQuotaResult(id, update, now, SOURCE.READ_ONLY_ENDPOINT),
          );
        }),
      );
      // The local tick also refreshes ages and countdowns when nothing is due.
      if (mine === generation) controller.render();
    };
    void refresh();
    timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    timer.unref?.();
  });

  pi.on("message_end", (event) => {
    controller.observeMessage(event);
  });

  pi.registerCommand("subscriptions", {
    description: "Show or change subscription quota panel details",
    handler: (args, ctx) => controller.command(args, ctx),
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
    if (!live) return;
    const now = Date.now();
    for (const [legacy, id, interval] of [
      ["codex", PROVIDER.CODEX, REFRESH_INTERVAL_MS],
      ["claude", PROVIDER.ANTHROPIC, CLAUDE_REFRESH_INTERVAL_MS],
    ] as const) {
      const update = usageFromHeaders(event.headers, legacy, now);
      if (!update) continue;
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      nextRefresh.set(id, now + interval);
      controller.update(toQuotaResult(id, update, now, SOURCE.RESPONSE_EVENT));
    }
  });

  pi.on("session_shutdown", stop);
}
