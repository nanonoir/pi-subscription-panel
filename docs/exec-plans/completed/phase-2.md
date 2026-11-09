# Phase 2 — Provider discovery and contracts

## Objective

Execute [PRD Phase 2](../../PRD.md#phase-2--discovery-and-adapter-contracts):
identify the user's installed integrations, establish evidence for safe quota
sources, and introduce tested provider-independent contracts without changing
the current Codex/native Anthropic runtime. Later adapters/UI/scheduling belong
to their own branches and phases.

## Context and authorization

- Base: `main` at `0b0b7c3`, clean working tree, remote
  `nanonoir/pi-subscription-panel`; working branch `feature/provider-discovery`.
- Owner authorized implementation of the remaining PRD with feature branches,
  commits, push, PR creation, and merges. npm publication is not authorized.
- Owner explicitly requires consultation before resolving unsupported quota
  sources, API/interaction limitations, or risks. Do not silently select a fallback.
- Preserve `docs/generated`, existing provider installation/authentication,
  selected models, and runtime identifiers. Never use inference as a quota probe.
- Settings package identifiers were read selectively without credential files:
  `@estebanforge/pi-antigravity-bridge`, GitHub `earendil-works/pi-claude-code`,
  `pi-atelier`, and the original `pi-subscription-limits` are configured. Do not
  load this local panel alongside the configured original during verification.
- Dependabot PR #1 is pre-existing and outside this delivery unit.

## Execution

- [x] Re-read the PRD and verify published baseline, remote/default branch,
      authorization, and absence of local changes.
- [x] Inspect installed provider package source/version and public CLI documentation,
      without reading credentials, private sessions/logs, or querying quota endpoints.
- [x] Record verified sources, limitations, risks, and source-specific evidence;
      consult the owner for decisions before adopting any unsupported/risky path.
- [x] Define a minimal typed result/adapter contract based on verified sources,
      supporting separate quota pools, explicit availability, and optional provenance.
      Do not wire new adapters into the runtime in this phase.
- [x] Add economical focused contract tests while preserving baseline tests;
      validate lint, types, formatting, and no runtime/auth changes.
- [x] Independent review, correct concrete findings, and reconcile durable docs.
- [x] Close/archive the implementation plan; delivery remains a separate subsequent step.
- [ ] Deliver a size-bounded PR to `main`, merge only after applicable checks pass,
      and verify resulting Git state before beginning the next phase.

## Validation strategy

Use Node unit tests, TypeScript, ESLint, Prettier, staged/diff review, and syntax
or content comparison of the existing runtime. No E2E, inference probes,
provider installation, or global settings changes. The single owner-authorized
Antigravity CLI quota validation is recorded below; no further live requests are
needed for contract tests. Record exact untested areas.

## Findings and decisions

Discovery evidence is recorded in [provider discovery](../../references/provider-discovery.md).
Claude Code exposes response-driven, potentially incomplete `claude-code.rate-limit`
diagnostics on successful ordinary responses. Antigravity has a network-backed
standalone `/usage` CLI path, not an identified passive quota event. The owner then
authorized one bounded standalone validation: agy 1.5.3 returned two independent
quota groups with 5h/weekly fractions and resets, `num_turns=0`, and all reported
token counters zero in about 5.9 seconds. No retry or polling was enabled.

The owner subsequently approved both acquisition choices, now reconciled in the
canonical PRD: Claude Code updates from each normal response with valid metadata,
without any extra/scheduled quota query or three-minute throttle; partial/missing
metadata retains the last observation and its actual age. The owner accepted the
internal aggregate-field compatibility risk. Antigravity automatic CLI refresh is
configurable and opt-in, minimum three minutes active / twenty minutes idle, with
no claim of an official safe polling threshold. Reset countdowns update locally.

## Implementation Outcome

### Implemented

Added standalone provider-independent quota contracts with independent pools and
per-window observation provenance, finite raw percentages and display clamping.
Claude Code has a response-driven `observeResponse(unknown)` capability that can
return no update; polling is a separate capability. Added focused runtime and
compile-time contract tests and narrowly included them in TypeScript checking.
The existing entrypoint, baseline tests, Atelier shim, dependencies and package
metadata remain unchanged. The contracts are not wired into the runtime.

### Deviations from Design

None. The initially marker-only Claude contract was corrected during review to
express the response-observation capability explicitly.

### Validation

The parent session reported `npm run check` passing formatting, lint, typecheck,
and all 13 tests, including three focused runtime tests. Comparison against `main`
confirmed the existing entrypoint, baseline tests, Atelier shim, dependencies,
package metadata and lockfile were unchanged. Independent review initially failed
the marker-only Claude contract; after correction, re-review passed with no blockers.
The single authorized Antigravity CLI validation and its limits are recorded above.

### Follow-up

Phase 3 integration and subsequent UI/scheduling work are out of scope. Claude's
internal aggregate fields remain unverified in a live response for this account;
live account and TUI behavior were not tested. Existing audit and distribution
limitations remain tracked in the development guide and provenance. Commit, push,
PR, CI and merge have not yet occurred; the parent session will handle delivery
and verify Git state before the next phase.

Subsequently, Phase 2 was merged as [PR #2](https://github.com/nanonoir/pi-subscription-panel/pull/2)
at `d6997cd` after CI passed.
