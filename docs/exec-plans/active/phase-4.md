# Phase 4 — Subscription presentation and preferences

## Objective and confirmed decisions

Implement [PRD Phase 4](../../PRD.md#phase-4--ui-accordion-and-persistence) from
`main` at `744666c`. Phase 3's pure adapters and bounded CLI transport were merged
as PRs [#3](https://github.com/nanonoir/pi-subscription-panel/pull/3) and
[#4](https://github.com/nanonoir/pi-subscription-panel/pull/4), after independent
review and passing CI. The production entry point still runs the original baseline.

The owner approved three visible provider panels with command/menu expansion
controls, not clickable headings. `/subscriptions` is optional for controlling
details; viewing quotas must not require a command once panels are enabled in
Atelier Display. Retain heading/summary when collapsed, independent preferences,
native Display hide/reorder, and existing identifiers. No Atelier patch/fork.
Source evidence is in [Atelier feasibility](../../references/atelier-feasibility.md).

## First delivery: actual-interaction spike

- [x] Build an isolated manual-test extension with clearly fictional quota data,
      unique test panel IDs, an explicit test command/menu, no persistence,
      network, provider/auth calls, timers, model selection, or global shortcuts.
- [x] Add inexpensive tests proving registration/disposal, independent detail
      toggling, retained headings/summaries, and no provider I/O through the spike.
- [x] Typecheck the fixture and document a portable PowerShell launch that loads
      only the existing Atelier host plus this fixture, not the production panel.
- [ ] Independently review, validate, and deliver the spike in a bounded PR.
- [ ] Obtain actual TUI observations from the owner. This environment has no
      interactive-terminal tool. Static and mocked tests do not satisfy this gate.

## After the gate (not implemented by the spike)

- Implement validated global preferences in the reserved agent configuration file,
  safe defaults, and schema/migration handling without secrets.
- Wire truthful provider rendering and response-driven Claude updates, keeping
  Codex/native Anthropic acquisition intact and Antigravity polling opt-in.
- Persist independent expansion, preserve per-window freshness, handle narrow
  layouts, and never query merely because a panel is toggled.
- Validate relevant unit/integration behavior and actual TUI observations, review,
  reconcile documentation, archive the plan, and deliver the production changes.
- Phase 5 owns reusable polling/backoff/cross-session hardening and release gates.

## Boundaries and validation

Preserve `docs/generated`, global provider/auth configuration, model execution,
and unrelated Dependabot work. Do not install packages or generate inference to
probe quota. Every PR must remain within the delivery size budget and pass
applicable checks before authorized merge. No costly E2E infrastructure.

## Outcome

Pending. The fixture will prove only the selected interaction pathway, not live
quota accuracy, account compatibility, preference persistence, or completed UI.

## Spike validation

`npm run check` passed formatting, lint, types, and all 24 fast Node tests,
including three fixture interaction/lifecycle tests. Comparison against `main`
confirmed no changes under `extensions/` or in package/lock metadata. Independent
review passed with no material issues and explicitly left the real TUI gate open.
The fixture and tests total 232 authored lines; TypeScript include configuration
adds five lines and removes one. Delivery follows; this phase is not complete.
