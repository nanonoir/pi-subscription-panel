import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ANTIGRAVITY_MODE,
  normalizePreferences,
  type PreferencesSaveResult,
  type SubscriptionPreferences,
} from "./preferences.ts";
import { describeFailure } from "./poll-outcome.ts";
import { PROVIDER, type ProviderId } from "./quota-contracts.ts";
import type { ProviderStatus } from "./refresh-runtime.ts";
import type { DeferralCause, RetryResult } from "./refresh-scheduler.ts";

/** Fixed registration and menu order; panel ids live in the presentation. */
export const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: PROVIDER.CODEX, name: "Codex" },
  { id: PROVIDER.CLAUDE_CODE, name: "Claude Code" },
  { id: PROVIDER.ANTIGRAVITY, name: "Antigravity" },
  { id: PROVIDER.ANTHROPIC, name: "Native Anthropic" },
];

const USAGE =
  "Usage: /subscriptions [status | toggle codex|claude-code|antigravity|anthropic | refresh antigravity|collapsed on|off | retry codex|claude-code|antigravity|anthropic]";
const SESSION_ONLY = "The change applies to this session only.";

const utcTime = (epochMs: number): string =>
  `${new Date(epochMs).toISOString().slice(11, 19)} UTC`;

const utcStamp = (epochMs: number): string =>
  `${new Date(epochMs).toISOString().slice(0, 19).replace("T", " ")} UTC`;

const CAUSE_TEXT: Record<DeferralCause, string> = {
  server: "server retry deadline",
  backoff: "failure backoff",
  gap: "minimum gap",
};

/** One sanitized line per provider; allowlisted reason codes and times only. */
function statusLine(
  name: string,
  { enabled, schedule }: ProviderStatus,
  now: number,
): string {
  const parts = [enabled ? "polling on" : "polling off"];
  if (schedule.blocked) parts.push(`paused (${schedule.blocked})`);
  if (schedule.inFlight) parts.push("read in progress");
  if (schedule.lastFailure) {
    const { atMs } = schedule.lastFailure;
    parts.push(
      `last failure: ${describeFailure(schedule.lastFailure)} at ${utcStamp(atMs)}`,
    );
  } else if (schedule.failureCount > 0 || schedule.lastError !== undefined) {
    // Legacy record: the failure is known, its reason and time are not. The
    // raw `lastError` text is never displayed.
    parts.push("last read failed: reason unknown");
  } else if (schedule.lastSuccessMs !== undefined) {
    parts.push(`last success ${utcStamp(schedule.lastSuccessMs)}`);
  } else {
    parts.push("no read result recorded");
  }
  for (const [label, at] of [
    ["gap until", schedule.gapUntilMs],
    ["backoff until", schedule.backoffUntilMs],
    ["server deadline", schedule.serverRetryAtMs],
  ] as const) {
    if (at !== undefined && at > now) parts.push(`${label} ${utcStamp(at)}`);
  }
  parts.push(
    schedule.blocked
      ? "manual retry required (deadlines above still apply to the retry)"
      : schedule.deferral
        ? `next read after ${utcStamp(schedule.deferral.untilMs)} (${CAUSE_TEXT[schedule.deferral.cause]})`
        : "next read eligible now",
  );
  return `${name}: ${parts.join(" · ")}`;
}

/** Honest, non-secret wording for an explicit retry request. */
function retryMessage(name: string, result: RetryResult): string {
  switch (result.status) {
    case "started":
      return `${name}: quota refresh started.`;
    case "deferred":
      return `${name}: retry deferred until ${utcTime(result.eligibleAtMs ?? 0)} (minimum gap or server deadline); no request was made yet and it runs on the first refresh tick after that time.`;
    case "in-flight":
      return `${name}: a refresh is already in progress.`;
    case "disabled":
      return `${name}: refresh is off or paused while collapsed; no request was made.`;
    default:
      return `${name}: refresh is not available right now; no request was made.`;
  }
}

export type ActionContext = Pick<ExtensionContext, "ui" | "mode">;

export interface SubscriptionActionsOptions {
  save: (
    preferences: SubscriptionPreferences,
  ) => Promise<PreferencesSaveResult>;
  /** Called synchronously with the new preferences after every change. */
  onChange: (preferences: SubscriptionPreferences) => void;
  /**
   * Explicit user retry of one polling provider; only this action may cause a
   * quota read from the UI. Undefined when no scheduler is running.
   */
  retry?: (id: ProviderId) => RetryResult | undefined;
  /** Read-only scheduling metadata; never causes a request. */
  status?: () => ProviderStatus[] | undefined;
  now?: () => number;
}

export function notifyWarning(ctx: ActionContext, message: string): void {
  ctx.ui?.notify?.(message, "warning");
}

export function createSubscriptionActions(options: SubscriptionActionsOptions) {
  let preferences = normalizePreferences({});
  let readOnly = false;
  let saves: Promise<void> = Promise.resolve();

  /** Queue one save of a normalized snapshot; saves never run out of order. */
  function persist(ctx: ActionContext): void {
    if (readOnly) {
      notifyWarning(ctx, `Preferences file is protected. ${SESSION_ONLY}`);
      return;
    }
    const snapshot = normalizePreferences(structuredClone(preferences));
    saves = saves
      .then(() => options.save(snapshot))
      .catch((): PreferencesSaveResult => ({ saved: false, warnings: [] }))
      .then((result) => {
        if (result.saved) return;
        const reasons = result.warnings.map((item) => item.message).join(" ");
        notifyWarning(
          ctx,
          `${reasons || "Preferences could not be saved."} ${SESSION_ONLY}`,
        );
      });
  }

  function change(next: SubscriptionPreferences, ctx: ActionContext): void {
    preferences = normalizePreferences(next);
    options.onChange(preferences);
    persist(ctx);
  }

  function toggle(id: ProviderId, ctx: ActionContext): void {
    const expanded = new Set(preferences.expandedProviders);
    if (!expanded.delete(id)) expanded.add(id);
    change(
      {
        ...preferences,
        expandedProviders: PROVIDERS.map((item) => item.id).filter((item) =>
          expanded.has(item),
        ),
      },
      ctx,
    );
  }

  /** Legacy command: panels only show remaining; saved preferences stay as is. */
  function explainDisplay(ctx: ActionContext): void {
    ctx.ui?.notify?.(
      "Panels always show remaining quota; the display setting is not changed.",
      "info",
    );
  }

  function setRefresh(
    target: "antigravity" | "collapsed",
    on: boolean,
    ctx: ActionContext,
  ): void {
    const { refresh } = preferences;
    if (target === "collapsed") {
      if (refresh.whileCollapsed !== on)
        change(
          { ...preferences, refresh: { ...refresh, whileCollapsed: on } },
          ctx,
        );
      return;
    }
    const mode = on ? ANTIGRAVITY_MODE.AUTO : ANTIGRAVITY_MODE.OFF;
    if (refresh.antigravity.mode !== mode)
      change(
        {
          ...preferences,
          refresh: {
            ...refresh,
            antigravity: { ...refresh.antigravity, mode },
          },
        },
        ctx,
      );
  }

  function retry(id: ProviderId, ctx: ActionContext): void {
    const name = PROVIDERS.find((item) => item.id === id)?.name ?? id;
    const result = options.retry?.(id) ?? { status: "stopped" as const };
    ctx.ui?.notify?.(retryMessage(name, result), "info");
  }

  /** Retained scheduling metadata only: no read, credential or persistence. */
  function status(ctx: ActionContext): void {
    const entries = options.status?.();
    if (!entries) {
      ctx.ui?.notify?.(
        "Refresh scheduling is not running; nothing to report.",
        "info",
      );
      return;
    }
    const now = (options.now ?? Date.now)();
    const lines = PROVIDERS.flatMap((item) => {
      const entry = entries.find((candidate) => candidate.id === item.id);
      return entry ? [statusLine(item.name, entry, now)] : [];
    });
    ctx.ui?.notify?.(
      `Refresh status (no request made):\n${lines.join("\n")}`,
      "info",
    );
  }

  function menuOptions(): string[] {
    return [
      ...PROVIDERS.map(
        (item) =>
          `${item.name} — ${preferences.expandedProviders.includes(item.id) ? "collapse" : "expand"} details`,
      ),
      `Antigravity refresh — ${antigravityOn() ? "disable" : "enable"}`,
    ];
  }

  function antigravityOn(): boolean {
    return preferences.refresh.antigravity.mode !== ANTIGRAVITY_MODE.OFF;
  }

  return {
    /** Replace the current preferences, e.g. after a load. */
    configure(next: {
      preferences: SubscriptionPreferences;
      readOnly: boolean;
    }): void {
      preferences = normalizePreferences(next.preferences);
      readOnly = next.readOnly;
    },

    get(): SubscriptionPreferences {
      return preferences;
    },

    /** Resolves once every queued save has settled. */
    flush(): Promise<void> {
      return saves;
    },

    /** `isCurrent` is re-checked after the asynchronous menu returns. */
    async command(
      args: string,
      ctx: ExtensionContext,
      isCurrent: () => boolean = () => true,
    ): Promise<void> {
      const input = args.trim();
      if (!input) {
        if (!ctx.ui?.select) return;
        const choices = menuOptions();
        const picked = await ctx.ui.select("Subscriptions", choices);
        if (!isCurrent()) return;
        const index = choices.indexOf(picked ?? "");
        if (index < 0) return;
        if (index < PROVIDERS.length) toggle(PROVIDERS[index].id, ctx);
        else setRefresh("antigravity", !antigravityOn(), ctx);
        return;
      }
      if (input === "status") {
        status(ctx);
        return;
      }
      const refresh = /^refresh (antigravity|collapsed) (on|off)$/.exec(input);
      if (refresh) {
        setRefresh(
          refresh[1] as "antigravity" | "collapsed",
          refresh[2] === "on",
          ctx,
        );
        return;
      }
      const [, verb, value] =
        /^(toggle|display|retry) (\S+)$/.exec(input) ?? [];
      const provider = PROVIDERS.find((item) => item.id === value);
      if (verb === "retry" && provider) {
        retry(provider.id, ctx);
        return;
      }
      if (verb === "toggle" && provider) toggle(provider.id, ctx);
      else if (
        verb === "display" &&
        (value === "used" || value === "remaining")
      )
        explainDisplay(ctx);
      else notifyWarning(ctx, USAGE);
    },
  };
}
