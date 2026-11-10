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
panel IDs. Do not silently rewrite Atelier settings to force visibility. Display
edits are a draft until **Save default** succeeds; runtime is unchanged before
that. Once enabled and saved there, no command is needed to keep viewing quotas
across sessions. The host may still drop an enabled contributed panel entirely
when vertical height is insufficient (no scrolling; contributed panels rank after
built-ins and reordering does not raise that rank). Host source: installed
0.18.0 `src/settings-workspace.ts` 254–262, 287–292, 322–347 and `src/sidebar.ts`
540–564, 639–668. Source review found no protocol mismatch between 0.16 and
0.18/Pi; the user-observed missing panels are not yet attributed to a cause.
Keep the existing `subscription:limits` ID for compatibility and never load the
original package and this copy simultaneously.

## Live interaction gate observed; production validation pending

Before calling the production UI complete, additionally verify persisted preferences,
no quota request on toggling, narrow layouts/resizing, and native Display hide/reorder
in the intended TUI host. Synthetic protocol tests cannot substitute for actual
interaction observations.

The owner subsequently supplied a screenshot showing all three TEST panels with
Codex collapsed (heading/summary retained) and the other providers expanded. The
command/menu pathway is therefore observed in an actual TUI, satisfying the
interaction spike gate. Persistence, resize behavior, and production provider data
are not established by that screenshot. No protocol/rendering fix is claimed;
see the [spike troubleshooting steps](atelier-spike.md#troubleshooting-test-panels-not-visible).

Do not patch/fork Atelier or claim clickable controls. The agent did not start a
TUI session, install packages, change authentication, or query a live provider for
this investigation; the actual interaction evidence came from the owner.
