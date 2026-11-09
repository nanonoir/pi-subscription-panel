import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSidebarPanel } from "pi-atelier/extensions/index.ts";

const PROVIDERS = [
  { id: "codex", name: "Codex", fiveHour: 75, weekly: 60 },
  { id: "claude-code", name: "Claude Code", fiveHour: 80, weekly: 55 },
  { id: "antigravity", name: "Antigravity", fiveHour: 65, weekly: 40 },
] as const;

type Provider = (typeof PROVIDERS)[number];
type Handle = ReturnType<typeof registerSidebarPanel>;

function panel(provider: Provider, expanded: boolean) {
  const keyValues = [
    { label: "TEST DATA", value: `${provider.fiveHour}% 5h remaining` },
    ...(expanded
      ? [
          { label: "TEST DATA 5h", value: `${provider.fiveHour}% remaining` },
          { label: "TEST DATA 1w", value: `${provider.weekly}% remaining` },
        ]
      : []),
  ];
  return {
    id: `subscription-spike:${provider.id}` as const,
    title: `${provider.name} · TEST`,
    rows: keyValues.map(({ label, value }) => `${label} ${value}`),
    keyValues,
  };
}

export default function interactionSpike(pi: ExtensionAPI): void {
  const handles = new Map<Provider["id"], Handle>();
  const expanded = new Map<Provider["id"], boolean>();
  let generation = 0;

  function stop(): void {
    generation += 1;
    for (const handle of handles.values()) handle.dispose();
    handles.clear();
    expanded.clear();
  }

  pi.on("session_start", (_event, ctx) => {
    stop();
    if (ctx?.mode !== "tui") return;
    for (const provider of PROVIDERS) {
      expanded.set(provider.id, true);
      handles.set(
        provider.id,
        registerSidebarPanel(pi, panel(provider, true), {
          source: "subscription-spike",
        }),
      );
    }
  });
  pi.on("session_shutdown", stop);

  pi.registerCommand("subscriptions-spike", {
    description: "Toggle fictional subscription TEST DATA details",
    handler: async (args, ctx) => {
      if (ctx?.mode !== "tui" || handles.size === 0) return;
      const currentGeneration = generation;
      const input = args.trim();
      let provider: Provider | undefined;
      if (!input) {
        if (!ctx.ui?.select) return;
        const options = PROVIDERS.map(
          (item) =>
            `${item.name} — ${expanded.get(item.id) ? "collapse" : "expand"} TEST DATA`,
        );
        const selected = await ctx.ui.select(
          "Subscriptions spike (TEST DATA)",
          options,
        );
        if (generation !== currentGeneration) return;
        provider = PROVIDERS[options.indexOf(selected ?? "")];
      } else {
        const match = /^toggle (codex|claude-code|antigravity)$/.exec(input);
        provider = PROVIDERS.find((item) => item.id === match?.[1]);
      }
      if (!provider) return;
      const handle = handles.get(provider.id);
      if (!handle) return;
      const next = !expanded.get(provider.id);
      expanded.set(provider.id, next);
      handle.update(panel(provider, next));
    },
  });
}
