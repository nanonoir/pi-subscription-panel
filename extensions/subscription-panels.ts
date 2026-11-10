import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerSidebarPanel } from "pi-atelier/extensions/index.ts";
import {
  DISPLAY_MODE,
  ANTIGRAVITY_MODE,
  loadPreferences,
  normalizePreferences,
  savePreferences,
  type PreferencesLoadResult,
  type PreferencesSaveResult,
  type SubscriptionPreferences,
} from "./preferences.ts";
import {
  createClaudeAdapter,
  mergeObservation,
  waitingState,
} from "./provider-adapters.ts";
import {
  AVAILABILITY,
  PROVIDER,
  type ProviderId,
  type QuotaResult,
} from "./quota-contracts.ts";
import { buildQuotaPanel } from "./quota-presentation.ts";
import {
  PROVIDERS,
  createSubscriptionActions,
  notifyWarning,
} from "./subscription-actions.ts";

const PANEL_SOURCE = "subscription-limits";

type Handle = ReturnType<typeof registerSidebarPanel>;

export interface SubscriptionPanelDeps {
  load?: () => Promise<PreferencesLoadResult>;
  save?: (
    preferences: SubscriptionPreferences,
  ) => Promise<PreferencesSaveResult>;
  now?: () => number;
}

function initialState(
  id: ProviderId,
  preferences: SubscriptionPreferences,
): QuotaResult {
  if (id !== PROVIDER.ANTIGRAVITY) return waitingState(id);
  // Antigravity detail collection is opt-in; polling belongs to a later phase.
  return preferences.refresh.antigravity.mode === ANTIGRAVITY_MODE.AUTO
    ? { ...waitingState(id), detail: "Awaiting refresh" }
    : {
        providerId: id,
        availability: AVAILABILITY.UNAVAILABLE,
        pools: [],
        detail: "Detail collection disabled",
      };
}

export function createSubscriptionPanels(
  pi: ExtensionAPI,
  deps: SubscriptionPanelDeps = {},
) {
  const load = deps.load ?? (() => loadPreferences());
  const save = deps.save ?? ((value) => savePreferences(value));
  const clock = deps.now ?? Date.now;
  const claude = createClaudeAdapter();
  const handles = new Map<ProviderId, Handle>();
  const states = new Map<ProviderId, QuotaResult>();
  // Observations received while the current start is still loading.
  const buffered = new Map<ProviderId, QuotaResult>();
  let active = false;
  let starting = false;
  let generation = 0;

  const actions = createSubscriptionActions({ save, onChange: () => render() });

  function contribution(id: ProviderId) {
    const preferences = actions.get();
    return buildQuotaPanel(states.get(id) as QuotaResult, {
      expanded: preferences.expandedProviders.includes(id),
      displayUsed: preferences.displayMode === DISPLAY_MODE.USED,
      now: clock(),
      staleAfterMs: preferences.staleAfterSeconds * 1000,
    });
  }

  function cleanup(): void {
    generation += 1;
    active = false;
    starting = false;
    for (const handle of handles.values()) handle.dispose();
    handles.clear();
    states.clear();
    buffered.clear();
  }

  function render(): void {
    for (const [id, handle] of handles) handle.update(contribution(id));
  }

  function update(result: QuotaResult | undefined): void {
    if (!result || !PROVIDERS.some((item) => item.id === result.providerId))
      return;
    const id = result.providerId;
    if (starting) {
      buffered.set(
        id,
        mergeObservation(buffered.get(id) ?? waitingState(id), result),
      );
      return;
    }
    if (!active || !states.has(id)) return;
    states.set(id, mergeObservation(states.get(id) as QuotaResult, result));
    handles.get(id)?.update(contribution(id));
  }

  return {
    async start(ctx: ExtensionContext): Promise<void> {
      cleanup();
      if (ctx?.mode !== "tui") return;
      const mine = generation;
      starting = true;
      await actions.flush();
      if (mine !== generation) return;
      const loaded = await load().catch((): PreferencesLoadResult => ({
        preferences: normalizePreferences({}),
        readOnly: true,
        warnings: [
          { code: "unreadable", message: "Preferences could not be read." },
        ],
      }));
      if (mine !== generation) return;
      actions.configure(loaded);
      for (const warning of loaded.warnings)
        notifyWarning(ctx, warning.message);
      for (const { id } of PROVIDERS) {
        const initial = initialState(id, actions.get());
        const early = buffered.get(id);
        states.set(id, early ? mergeObservation(initial, early) : initial);
      }
      buffered.clear();
      for (const { id } of PROVIDERS)
        handles.set(
          id,
          registerSidebarPanel(pi, contribution(id), { source: PANEL_SOURCE }),
        );
      starting = false;
      active = true;
    },

    stop: cleanup,
    update,
    render,

    observeMessage(event: unknown): void {
      if (active || starting) update(claude.observeResponse(event));
    },

    async command(args: string, ctx: ExtensionContext): Promise<void> {
      if (ctx?.mode !== "tui" || !active) return;
      const mine = generation;
      await actions.command(args, ctx, () => mine === generation);
    },
  };
}
