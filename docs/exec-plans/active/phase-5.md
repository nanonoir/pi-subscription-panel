# Phase 5 — Refresh safety, hardening, and release preparation

## Context and objective

Continue [PRD Phase 5](../../PRD.md#phase-5--refresh-tuning-hardening-and-release)
from `main` at `d15e0e4`, after the reviewed Phase 4 runtime was merged as
[PR #13](https://github.com/nanonoir/pi-subscription-panel/pull/13) with passing CI
and 78 local tests. Phase 4's production persistence/resize smoke remains explicitly
pending and may be combined with the final smoke; do not claim it already passed.

The owner supplied a separate official Pi Codex OAuth session for quota only;
existing `openai/{model}` execution stays unchanged. Claude Code updates only from
ordinary message metadata. Antigravity's existing CLI quota source was validated
once and automatic acquisition remains opt-in. No further live probes or inference
requests are needed for implementation tests.

## Approved design and constraints

Follow [safe refresh scheduling](../../design-docs/refresh-scheduling.md):

- Per-provider, per-process exclusion and cooldowns survive `/reload` where the
  actual loader shares its global realm. Separate Pi processes can query
  independently, as explicitly accepted by the owner. No shared quota-value cache,
  account identifiers/hashes, new service process, or cross-process lock subsystem.
- Codex defaults to 60 seconds; native Anthropic remains separate at 30 minutes.
  Antigravity is off until opted in, minimum three-minute active/twenty-minute idle
  gaps, with relevant-provider activity defined explicitly. Claude is excluded
  structurally from polling. Ages/countdowns update locally every minute.
- Honor server retry deadlines, recoverable backoff with nonnegative jitter, and
  manual blocks on known 401/403 or unavailable auth. An indeterminate Antigravity
  error pauses automation until explicit manual retry, as accepted by the owner.
- Manual retry respects minimum gaps and known server deadlines; it does not log
  in, reroute models, or infer usage. Repaint, expansion and reload do not clear a
  manual block. Keep refresh-while-collapsed policy independent of expansion.
- Cancel supported transports on stop/disable, keep exclusion until settlement,
  and generation-guard publication. Normal Pi token renewal must settle safely.
- Preserve `docs/generated`, unrelated Dependabot work, existing provider installs,
  credentials and model execution. No npm publication is authorized; license and
  redistribution evidence still block distribution.

## Execution units

- [x] Confirm runtime PR #13 merged and create `feature/subscription-refresh`.
- [ ] Verify actual extension reload/global-state behavior with source or an
      isolated synthetic loader test (never start providers or Pi sessions).
- [ ] Add sanitized poll outcomes and fake-clock scheduler behavior with explicit
      failure classes, deadlines, in-flight exclusion and manual retry semantics.
- [ ] Add process-local reload metadata coordination without storing quota values.
- [ ] Wire transport cancellation/outcomes and root scheduling, opt-in Antigravity,
      relevant activity, retry controls, and independent collapsed refresh policy.
- [ ] Validate focused parsing/scheduling/transport/preferences/runtime tests,
      including 429, Retry-After, 401/403, offline/partial data, reload/stop and
      zero inference or query on ordinary UI controls.
- [ ] Independent review/corrections, docs reconciliation, and size-bounded Git
      deliveries with passing applicable CI. Each behavior ships with its tests.
- [ ] Recheck dependency audit and safe package metadata without blind upgrades,
      license assertions, publication, or changes to the owner's global harness.
- [ ] Complete the combined actual-TUI production smoke with the owner, record
      remaining limits honestly, and delegate plan closure/reconciliation.

## Validation strategy

Use deterministic clock/random/deferred-promise tests and process doubles; no
sleeping, stress tests, E2E infrastructure, or additional authenticated quota reads.
The final small suite is pre-PR validation targeting `main`; use focused tests
while iterating. Document exactly what synthetic checks and actual observations
prove. Keep each authored PR at most 600 lines; split coherent modules, never move
related behavioral tests into a test-only follow-up to bypass the budget.

## Outcome

Pending. Technical completion, manual acceptance, and release/publication are
different gates; repository delivery authorization does not authorize npm publishing.

## Compaction checkpoint

Phase 4 runtime delivery is merged as PR #13 (`d15e0e4`); its actual production
persistence/resize smoke remains pending and its plan stays active. Codex quota
access was verified with the owner-supplied Pi Codex session; model execution is
unchanged. Do not repeat live quota probes to resume this work.

The first Phase 5 unit implements only `poll-outcome.ts` and its 13 focused tests:
sanitized success/failure/cancelled outcomes, known auth/rate-limit/manual classes,
no windows on failure, validated finite readings, and preserved server deadlines.
Independent review passed. It is not wired into acquisition or a scheduler yet.

This unit is published for delivery as PR #14. Parent `npm run check` passed all
91 current tests plus lint, types and formatting. Reload investigation inspected
installed Pi's Jiti loader (`moduleCache: false`) and shutdown/reload lifecycle.
An isolated, no-file synthetic test using two fresh installed Jiti instances
confirmed shared host `globalThis` and `Symbol.for` identity (counter 1 then 2).
It exercised `evalModule`, not Pi's real `jiti.import` or end-to-end `/reload`;
retain that limit when implementing and validating the process registry.

Remaining: scheduler engine, process-local reload/exclusion metadata, cancellation
and structured outcomes in transports, opt-in Antigravity scheduling, manual retry,
independent refresh-while-collapsed policy, focused integration checks, dependency
audit/release preparation, and combined owner TUI acceptance. Do not claim Phase 5
or the complete PRD finished. Existing provider/model/authentication boundaries,
owner-approved per-process scope and pause-on-indeterminate-Antigravity policy remain.
