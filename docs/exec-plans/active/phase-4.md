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
- [x] Independently review, validate, and deliver the spike in a bounded PR.
- [x] Obtain actual TUI observations from the owner. This environment has no
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

## Outcome — blocked on required OpenAI quota source

The command/menu interaction gate is satisfied by the owner's screenshot: all
three TEST panels rendered, with Codex collapsed retaining its heading/summary
while Claude Code and Antigravity remained expanded. This does not establish live
quota accuracy, account compatibility, preference persistence, resizing behavior,
or completion of the production UI. Production implementation remains pending.

## Spike validation

`npm run check` passed formatting, lint, types, and all 24 fast Node tests,
including three fixture interaction/lifecycle tests. Comparison against `main`
confirmed no changes under `extensions/` or in package/lock metadata. Independent
review passed with no material issues and explicitly left the real TUI gate open.
The fixture and tests total 232 authored lines; TypeScript include configuration
adds five lines and removes one. Delivery follows; this phase is not complete.

## Owner TUI observation and visibility diagnosis

The spike was merged as PR #5 (`3c6b4ab`). The owner initially reported no panels.
Read-only investigation found no registration-protocol mismatch; Atelier requires
Display edits to be saved and may drop entire contributed panels under height
pressure. A fix-agent corrected those omissions in the manual instructions. The
owner then supplied the successful three-panel screenshot described above. The
exact cause of the earlier invisibility was not independently established; do not
claim a renderer/protocol bug was fixed. Never patch Atelier or force its layout.

## Production delivery units

Deliver each unit from the preceding merged `main`, within the authored-code
budget, with focused tests and independent review:

1. Global preferences module/schema and atomic local persistence, with synthetic
   temporary-file tests. Preserve `getAgentDir()`/the reserved config filename,
   default remaining display/all providers expanded, response-only Claude policy,
   and default-off Antigravity. Unknown future schemas must not be overwritten.
2. Pure responsive provider presentation: actual reported windows only, independent
   pools, labelled used/remaining display, countdowns/observation age, missing/error
   states, and collapsed header/summary. Preserve host row/text limits.
3. Runtime wiring and `/subscriptions` menu/direct controls with persistence and
   response-driven Claude observation. Keep Codex/native Anthropic acquisition
   intact and distinguish native Anthropic from Claude Code. No inference probe,
   extra request on expansion, or automatic Antigravity polling before Phase 5.

Use a configurable three-minute observation-age threshold for stale labels (not
a Claude polling interval or provider guarantee). Phase 5 will harden scheduling
and coordination. Validate production persistence/layout separately; the spike
only established the approved interaction pathway.

## Preferences unit progress

Implemented schema-1 normalization and explicit local persistence, with ten
temporary-file tests. Defaults preserve all providers' expanded details, remaining
display, response-only Claude, default-off Antigravity, and conservative interval
minimums. Loading never writes; unknown/malformed schemas are protected from
ordinary explicit saves. Atomic rename is not a cross-session transaction; a
concurrent replacement between read-check and rename is not claimed protected.
Independent review passed with no material issues. Runtime wiring remains out of
this unit; no real agent-directory file or provider was accessed in tests.

Preferences were delivered as PR #6 and merged at `57e02d7` after passing CI.
Presentation review then found stale summaries could be hidden by truncation, and
missing/non-finite data needed explicit explanations. Keep those corrections and
their regression tests. To remain within the 600-line budget without dropping
coverage, split pure text/time/freshness formatting from panel assembly into
separately tested delivery units before wiring the runtime.

An additional read-only Pi 1.5 compatibility check confirmed public APIs remain
compatible, but the owner's new `openai` subscription path is distinct from legacy
`openai-codex`. No credential/endpoint substitution is authorized. The owner has
been asked how to handle absent quota for that path; record the decision before
adopting a fallback or changing acquisition. Independent presentation work can
continue without resolving that credential/source gate.

## Presentation unit review

Review found three correctness gaps and their regression coverage was corrected:
mixed/partial stale readings must stay visible in collapsed summaries, missing
known windows/pools require an explanation without fake bars, and non-finite
percentages must be unavailable. A further bounded-row reproduction showed why
the freshness warning must precede error/clamp detail; the long-row test now
actually selects an out-of-range tightest window and verifies truncation occurs
without dropping the leading `STALE/UNKNOWN` marker. Final independent review passed.

Delivery is split into pure `quota-format.ts` helpers/tests (142 authored lines),
then panel assembly/tests (approximately 580 authored lines), each under 600.
The parent ran all 16 focused format/presentation tests successfully, plus typecheck
and formatting. Production integration and actual resize/persistence remain pending.

## Controller foundation corrections

The first controller review identified lost response-driven observations while
preferences load asynchronously, and a cancelled start initiating a read after a
pending save. Buffer observations per startup generation, discard cancelled work,
and check generation before any post-save load. Add deferred load/save regressions.
Preserve serialized explicit saves and truthful session-only failure notices.

This unit also exceeded 600 authored lines. Separate preference command/save actions
from panel lifecycle/observation management into coherent, separately tested delivery
units rather than dropping necessary coverage or compressing code to fit.

Pure formatting helpers were merged as PR #7 at `637dfe1` after passing CI.
The subsequent panel-assembly unit contains 580 authored source/test lines and
has a passing independent final review with all 16 combined format/render tests
passing. It does not activate the presentation or acquire provider data yet.

Panel assembly was subsequently merged as PR #8 at `ed9c45d` after CI passed.
The controller corrections now pass independent re-review: startup observations
are buffered by generation, cancelled starts check generation before any post-save
read, and deferred load/save regressions cover both paths. Preference command/save
actions were separated from panel lifecycle with a shared focused test fixture.
All 22 actions/controller tests pass locally, plus types, lint, and formatting.

Deliver actions+their tests/shared fixture first (377 authored lines), then panel
lifecycle+its tests (588 authored lines). Both remain unwired to the entry point,
and no live provider/configuration file was accessed during validation.

Preference actions were merged as PR #9 at `d7b0238` after passing CI. The final
standalone controller unit has 588 authored lines and a passing independent
re-review. Parent pre-delivery `npm run check` passed all 72 fast tests, formatting,
lint, and types; the baseline entry point and package/lock remain unchanged.
Runtime wiring is still pending the OpenAI source decision and subsequent
integration/real-provider validation. This phase must not be archived as complete.

## Canonical OpenAI identity clarification

After PR #10 merged at `5e3ddce`, the owner confirmed `openai/{model}` is canonical
and `openai-codex` was the incorrect legacy implementation. Do not ask the owner to
select it or reauthenticate. This resolves provider identity, not endpoint/token
compatibility. The PRD now requires the current `openai` integration; public-source
quota investigation continues without live requests or credential access. Runtime
wiring is on `feature/subscription-runtime` and must not silently send current
credentials to the legacy quota endpoint or invent a quota percentage.

## Authorized compatibility probe outcome

Following the owner's community report and explicit one-probe authorization, a
safety-reviewed temporary diagnostic resolved only the installed Pi `openai` OAuth
and attempted one fixed WHAM GET (ten-second timeout, no redirects/retries). It
returned HTTP 401; no account header was obtainable via the resolved headers/token
metadata used, and no valid quota windows were received. No inference, alternate
credential/provider, CLI installation, or login change was performed. Only sanitized
status metadata was emitted; the body was cancelled and normal SDK writes settled.

The exact rejection cause is not established. Real Codex percentages/resets remain
an unmet mandatory requirement, not an approved unavailable fallback. Stop further
live probing under this permission and retain this plan as blocked/incomplete.
Evidence and limits are recorded in [provider discovery](../../references/provider-discovery.md).
