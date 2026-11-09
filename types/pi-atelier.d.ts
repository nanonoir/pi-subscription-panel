declare module "pi-atelier/extensions/index.ts" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

  type SidebarRole =
    | "primary"
    | "accent"
    | "muted"
    | "dim"
    | "ready"
    | "working"
    | "input"
    | "output"
    | "cache"
    | "context"
    | "success"
    | "caution"
    | "warning"
    | "error";

  export function registerSidebarPanel(
    pi: Pick<ExtensionAPI, "events">,
    panel: {
      id: `${string}:${string}`;
      title: string;
      role?: SidebarRole;
      rows: readonly (string | { text: string; role?: SidebarRole })[];
      keyValues?: readonly {
        label: string;
        value: string;
        labelRole?: SidebarRole;
        valueRole?: SidebarRole;
        progress?: number;
      }[];
    },
    options?: { source?: string },
  ): {
    update(panel: Parameters<typeof registerSidebarPanel>[1]): void;
    dispose(): void;
  };
}
