# Phase 3 — Provider data adapters

## Objective and context

Implement [PRD Phase 3](../../PRD.md#phase-3--provider-data-adapters) on
`feature/provider-adapters`, based on `main` merge `d6997cd`. Phase 2 was
delivered and merged as [PR #2](https://github.com/nanonoir/pi-subscription-panel/pull/2)
after independent review and passing GitHub CI.

The acquisition decisions and observed installed schemas are recorded in
[provider discovery](../../references/provider-discovery.md). Claude updates only
from ordinary responses, with no extra quota request or polling throttle.
Antigravity's existing CLI quota path is approved for configurable opt-in refresh;
the one authorized validation reported zero turns/tokens. No additional live
request is needed for implementation tests.

## Scope and boundaries

- Implement adapters and provider-independent observation state using Phase 2
  contracts: verified Claude message diagnostics, independent Antigravity groups,
  optional reported reset timestamps, explicit waiting/unavailable/error states.
- Guard Claude observations by actual message role/provider/diagnostic type. Do
  not use selected model identity to misattribute an ordinary response.
- Preserve last-known partial windows with their individual observation times;
  stale/age projections must not invent a fresh observation or missing percentage.
- Antigravity subprocess acquisition must be disabled by default, bounded, and
  invoke only the exact standalone `/usage` command through the existing binary
  selection. Never prompt, reauthenticate, install a CLI, or expose raw stdout,
  stderr, credentials, or private metadata in errors.
- Preserve the existing Codex and native Anthropic runtime, provider auth/model
  execution, identifiers, and dependency ranges. Do not touch `docs/generated`.
- Keep new adapters standalone behind explicit constructors/capability detection
  until Phase 4 wires the new presentation/configuration. Phase 5 owns scheduling
  and cross-session request coordination. Clearly document this intermediate state.
- No interactive accordion, persisted configuration, timers, automatic polling,
  global settings changes, or live provider probes in this phase.

## Execution

- [x] Verify Phase 2 merge and create the next feature branch from clean `main`.
- [x] Confirm exact Pi event and installed-provider payload shapes with read-only
      source inspection; resolve any new risks with the owner before proceeding.
- [x] Implement minimal adapters/state and synthetic tests (including invalid,
      partial, stale, independent-pool, disabled, timeout/error, and no-data cases).
- [ ] Validate focused tests, types, lint, formatting, no baseline runtime changes,
      no secrets or unrelated work, and authored PR size at most 600 lines.
- [ ] Independent review and corrections; reconcile documentation and archive plan.
- [ ] Commit, push, open PR, and merge only after applicable checks pass.

## Validation strategy

Use the existing inexpensive Node VM/transpile testing approach, with injected
subprocess execution and synthetic quota fixtures. Run only relevant unit tests
while iterating, then the small baseline+adapter tests before delivery. No E2E,
inference probes, private session reads, or repeated CLI quota checks. GitHub CI
validates the PR on Node 22. Record live account/TUI limitations explicitly.

## Outcome

Pending. Delivery is authorized; the Atelier interaction feasibility gate remains
a separate Phase 4 decision and must not be replaced by a fake clickable accordion.

## Source findings

Pi's `message_end.message` carries the assistant provider and diagnostics; the
selected model is not a reliable attribution source. Claude diagnostic timestamps
are epoch milliseconds while window resets are epoch seconds. Only the aggregate
`unifiedWindows` mapping was verified in the installed schema, so no top-level
limiting-window fallback will be invented. Missing fields remain missing.

The bridge selects `AGY_BIN || "agy"` with inherited environment and no shell for
standalone quota. Its ACP staging normally links the existing application data,
but this does not independently prove account identity under custom home/environment
overrides. The adapter must not claim to verify account matching or replace credentials.

The existing panel format lacks per-window provenance and has a contributed-row
limit. Adding rows to it now could truncate or mislabel data. Keep the adapters
standalone and test their truthful states; integrate new presentation only after
the separate Phase 4 feasibility/owner gate.

## Delivery split and review correction

Independent review identified a real subprocess lifecycle issue: rejecting on
overflow did not ensure an explicitly bounded cleanup/settlement path. Added an
owned-child SIGKILL, explicit watchdog, stream cleanup, and deterministic tests
without invoking the CLI. Independent re-review passed both delivery units;
the reviewer ran all eight focused adapter/transport tests successfully.

Those necessary tests bring authored changes above 600 lines. Deliver two coherent
PRs instead of omitting coverage or requesting an oversized PR: first pure response
parsing and observation state; then the separately isolated opt-in Antigravity CLI
transport and its lifecycle tests. Each starts from the preceding merged baseline.
Keep this phase active until both units are reviewed, validated, and delivered.

- Unit 3a: `provider-adapters.ts` and its pure tests (376 authored lines), plus
  discovery/approved-policy and development documentation; transport stays out of
  this first PR.
- Unit 3b: isolated `antigravity-cli.ts` and lifecycle tests (335 authored lines).
  Its explicit constructor remains disabled by default and unwired from runtime.

The owner also approved the Phase 4 command/menu fallback: subscriptions remain
visible in the sidebar; `/subscriptions` only controls expanded details while
headers/summaries remain. Static Atelier evidence and the still-pending live TUI
gate are recorded in [Atelier feasibility](../../references/atelier-feasibility.md).
