# Atelier contribution feasibility

## Static API findings

Inspected the repository's `pi-atelier` 0.16.0 and the owner's installed 0.18.0.
Both expose protocol version 1 and presentation-only contributions. The public
`SidebarPanelContribution` accepts id/title/rows/keyValues/role; registration
returns only `update()` and `dispose()`. Public protocol events are registration,
unregistration, and discovery, not interaction. Sanitizers reconstruct accepted
fields, so adding arbitrary click handlers cannot enable interaction.

Evidence in both packages: `src/sidebar-panels.ts` contribution types and protocol,
`src/sidebar.ts` contributed-row rendering, and the README's contributed-sidebar
section. Native sidebar resize/drag behavior does not expose row-click callbacks.
This is source inspection, **not a live TUI interaction test**.

Pi separately documents commands with `ctx.ui` dialogs/custom components. That
allows explicit command/menu controls, not clicking a contributed heading.

## Owner-approved direction

The owner accepted command/menu control while preserving the always-present quota
view. The [canonical requirements](../PRD.md#3-target-ui-and-behavior) describe three
contributed provider panels, with `/subscriptions` as an optional expand/collapse control. Collapsing hides only
details and retains the provider heading/summary and usage state; it must not
unregister or globally hide a panel. This is **not a clickable accordion**.

Atelier starts new contributions hidden. Its Settings → Display remains the
authority for enabling/hiding/reordering panels, normally a one-time setup for new
panel IDs. Do not silently rewrite Atelier settings to force visibility. Once
enabled there, no command is needed to keep viewing quotas across sessions.
Keep the existing `subscription:limits` ID for compatibility and never load the
original package and this copy simultaneously.

## Live feasibility gate still pending

Before calling the interaction complete, prove the approved command/menu path in
an actual Pi TUI with the intended host version. Verify independently toggled
details, persistent preferences, header visibility, no quota request on toggling,
narrow layouts/resizing, and native Display hide/reorder. Synthetic protocol tests
cannot substitute for that observation.

Do not patch/fork Atelier or claim clickable controls. No TUI session, installation,
authentication change, or live provider query was performed for this investigation.
