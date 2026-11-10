import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DISPLAY_MODE,
  normalizePreferences,
  type PreferencesSaveResult,
  type SubscriptionPreferences,
} from "./preferences.ts";
import { PROVIDER, type ProviderId } from "./quota-contracts.ts";

/** Fixed registration and menu order; panel ids live in the presentation. */
export const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: PROVIDER.CODEX, name: "Codex" },
  { id: PROVIDER.CLAUDE_CODE, name: "Claude Code" },
  { id: PROVIDER.ANTIGRAVITY, name: "Antigravity" },
  { id: PROVIDER.ANTHROPIC, name: "Native Anthropic" },
];

const USAGE =
  "Usage: /subscriptions [toggle codex|claude-code|antigravity|anthropic | display remaining|used]";
const SESSION_ONLY = "The change applies to this session only.";

export type ActionContext = Pick<ExtensionContext, "ui" | "mode">;

export interface SubscriptionActionsOptions {
  save: (
    preferences: SubscriptionPreferences,
  ) => Promise<PreferencesSaveResult>;
  /** Called synchronously with the new preferences after every change. */
  onChange: (preferences: SubscriptionPreferences) => void;
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

  function setDisplay(used: boolean, ctx: ActionContext): void {
    const displayMode = used ? DISPLAY_MODE.USED : DISPLAY_MODE.REMAINING;
    if (displayMode !== preferences.displayMode)
      change({ ...preferences, displayMode }, ctx);
  }

  function menuOptions(): string[] {
    return [
      ...PROVIDERS.map(
        (item) =>
          `${item.name} — ${preferences.expandedProviders.includes(item.id) ? "collapse" : "expand"} details`,
      ),
      `Display — show ${preferences.displayMode === DISPLAY_MODE.USED ? "remaining" : "used"}`,
    ];
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
        else setDisplay(preferences.displayMode !== DISPLAY_MODE.USED, ctx);
        return;
      }
      const [, verb, value] = /^(toggle|display) (\S+)$/.exec(input) ?? [];
      const provider = PROVIDERS.find((item) => item.id === value);
      if (verb === "toggle" && provider) toggle(provider.id, ctx);
      else if (
        verb === "display" &&
        (value === "used" || value === "remaining")
      )
        setDisplay(value === "used", ctx);
      else notifyWarning(ctx, USAGE);
    },
  };
}
