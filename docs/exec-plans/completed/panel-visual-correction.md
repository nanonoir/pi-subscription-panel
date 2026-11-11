# Panel visual correction and simpler activation

## Objective

Align the actual subscription panel with the owner's reference: provider heading,
window name and reset duration on one line, bar and explicitly remaining percentage
on the next; no redundant reset label. Show `(waiting refresh)` for Claude Code
while awaiting a reading. Diagnose the reported inverted
percentage and correct the actual source-to-display path without invented values.

Investigate why the observed single legacy-style panel differs from the current
separate contribution implementation. Simplify Antigravity activation using Atelier
Display if supported, without silently introducing unauthorized background CLI
execution or changing provider/model credentials. If Display does not expose its
visibility state to extensions, document the limitation and select the simplest
safe control rather than claiming integration that cannot work.

## Execution and validation

- [x] Audit used/remaining conversion and implement truthful remaining values and
      the compact reference layout.
- [x] Implement Antigravity refresh opt-in through the `/subscriptions` menu,
      separately from Atelier Display visibility.
- [x] Run focused tests and independent reviews; reconcile documentation for the
      implemented presentation and freshness policy.
- [x] Owner confirmed production functionality and release readiness; no repeat
      acceptance gate is required. The old loaded copy was not identified.
- [x] Close implementation work; Git release delivery continues separately.

## Owner-approved Claude Code startup quota

The owner authorized using the existing Claude Code session for a read-only
usage query. One bounded request using Claude Code's local credential store and
the Anthropic OAuth usage endpoint returned HTTP 200 with valid five-hour and
weekly windows; no inference, alternate login, credential output or refresh was
performed. The installed `opencode-quota` plugin demonstrates the source and
uses five-minute caching. The implementation adds a bounded startup read using that
session only, without logging or storing credentials, preserves ordinary response
updates, and applies conservative refresh/backoff. Native Anthropic and OpenCode
credentials are never substituted. The PRD reflects this owner-approved change.
No further live calls are authorized by the one-query validation.

## Owner-approved presentation and stale-policy correction

A screenshot of the expanded Claude Code panel already shows both 5h (27%) and
weekly (64%) windows, so acquisition and parsing are correct and unchanged. The
defects are presentation and policy:

- [x] Stale policy: the 180 s threshold is shorter than the Claude Code (5 min) and
      Antigravity (3 min active / 20 min idle) refresh gaps, so healthy data always
      looked stale. Decision: the effective threshold per provider is
      `max(staleAfterSeconds, refresh gap + 60 s)`, where 60 s is the existing
      minimum of the user's own `staleAfterSeconds` preference used as grace for
      probe duration and one tick. Gaps come from the real scheduler minimums and
      the user's configured intervals (Antigravity uses the idle gap, the longest
      and therefore conservative one). Result with defaults: Codex 180 s
      (unchanged), Claude Code 6 min, Antigravity 21 min, Native Anthropic 31 min.
      No request, gap or bound changes.
- [x] Clean UI: no observed age for fresh data; staleness is one compact
      provider-level row (`STALE · 12m ago`, `AGE UNKNOWN`, or `STALE/UNKNOWN k/n`);
      windows are marked individually only when freshness is mixed. Every window
      uses the same layout: name + reset, then meter + remaining left.
- [x] Antigravity pool ids are shown as readable names; pools and windows are
      ordered deterministically (5h, then weekly, then others by name).
- [x] The ambiguous standalone `limited` row is removed (the caution color on the
      percentage already conveys it); `LOW` (<=10%) stays and 0% adds `EXHAUSTED`.
      Error/unavailable/clamp states are unchanged.
- [x] Collapsed panels list pool windows as compact meter rows within the 24-row
      contribution limit (reset times appear when expanded), instead of only the
      tightest one. Defaults already expand all providers; no migration is applied,
      so an explicitly saved collapse list (including `[]`) is respected as is.
- [x] Preserve mixed-freshness window warnings and place provider errors before
      expendable rows so truncation does not hide them.

## Startup/reload waiting correction

Reported: panels wait indefinitely after startup/reload without a query. Evidence
from code: a fresh start has no `lastAttempt`, so the first tick starts every
enabled reader. A reload creates a new controller whose panel snapshots are empty,
while the process registry keeps `lastAttempt` per provider on purpose (no shared
quota-value cache, no bypass of rate gaps). Within the gap the tick correctly
skips the read, but nothing told the UI, so it showed a bare "waiting" with no
time. Defect: lifecycle/state communication, not scheduling.

- [x] Runtime surfaces a sanitized deferred state (next eligible time, no quota
      values) at start when a provider is enabled, not blocked, and not yet read.
      Subsequent ticks synchronize a later retained Retry-After deadline.
- [x] Expanded empty panels show the state once (no duplicate no-data + State row).
- [x] Mocked lifecycle tests: startup read, reload within gap (no extra read,
      accurate countdown, no duplicate), eligible tick reads without a model
      message; fresh start reads Codex and Claude Code independent of the selected
      model provider.
- [ ] Native Anthropic "Error" cause is unknown; not claimed fixed.

Final review of the startup/reload correction: PASS. The implementer ran 148
focused tests, then 70 focused tests after the fix; the reviewer ran 27 focused
lifecycle/runtime tests. All passed, along with typecheck and focused ESLint and
Prettier checks. These mocked checks do not establish production TUI acceptance.

## Failure reason and deadline diagnostics correction

Reported: after a reload the panel said "Next read deferred by the minimum refresh
gap" although the real cause was a failed read with backoff or a server deadline.
Cause: the process registry kept only a fixed failure class (`lastError`) and one
merged `nextEligibleMs`; the HTTP status and the deadline kind were lost, and the
runtime always wrote the gap text. Owner-approved strategy:

- [x] Keep, per provider in the existing registry, bounded scheduling metadata
      only: an allowlisted failure reason code (`http`, `timeout`, `network`,
      `query`, `format`, `session-unavailable`, `manual-retry`, `unknown`) derived
      from transport facts or exact known fixed strings, plus a validated HTTP
      status (100-599) and the failure time. No raw error text, body, token, path
      or account. Unrecognized reasons are stored as `unknown` and shown as such.
- [x] Expose the three deadlines separately (normal gap, backoff, server
      deadline) and one effective deferral cause: the latest deadline still in
      the future; ties resolve server > backoff > gap, used everywhere.
- [x] A success clears failure, backoff and server deadline. A retired (reloaded
      or stopped) controller's late failure keeps only this safe metadata (reason,
      status, deadline, authentication block as before); a late success records
      nothing, so no stale success survives.
- [x] The reload "deferred" panel state names the actual last failure and the
      effective cause; "minimum refresh gap" is shown only when it is the cause,
      and a deferral with no known failure is shown as unknown.
- [x] New read-only `/subscriptions status` prints the retained metadata and
      deadlines from the registry with no request, credential access or
      persistence. `/subscription-debug` is unchanged (it still arms the ordinary
      response observer).
- [x] Focused mocked tests, typecheck, lint, format; documentation and help.
      No quota cache, persistence, interval, routing, auth or provider change.
      No Git delivery.

The diagnostics implementation scope is complete: legacy records without a safe
reason, including blocked records, report an unknown reason rather than exposing
old error text. Status gives a manual-retry block priority over an otherwise
eligible deadline; the displayed deadlines still constrain that retry. The cause
of the previously observed Claude Code 20-minute delay cannot be recovered
retrospectively from the old metadata.

Final independent review: PASS; 50 focused mocked tests passed, as did typecheck,
lint and format. No live network or credential access was used for this scope,
and no real 4xx/5xx after a real reload was observed in the production TUI.
The owner still needs to check status and the panel in the actual TUI. This
completes the diagnostics scope, not the broader plan's production acceptance gate.

## Owner-approved in-memory quota retention across reload

The owner explicitly approved an architecture adjustment that supersedes the
earlier "no shared quota-value cache" restriction (kept above as history): after
`/reload` the panel should immediately show the last successful observations with
their original `observedAt` and source, while the scheduler's gaps, backoff and
server deadlines stay untouched. Constraints and decisions:

- [x] Durable decision reconciled in the [refresh design](../../design-docs/refresh-scheduling.md)
      and [architecture](../../../ARCHITECTURE.md): a separate process-local,
      memory-only store (`extensions/quota-memory.ts`, own versioned
      `Symbol.for` registry), never written to disk, never shared across
      processes. The scheduler registry is unchanged and still holds metadata only.
- [x] Isolation (superseded in detail by the binding decisions below): entries are keyed by agent-directory scope and provider, and
      bound to an opaque authentication-context digest (HMAC-SHA256 with a random
      per-process key kept only in memory). No token, account id or reversible
      value is stored. Context sources reuse credentials the readers already use,
      with no network and no token renewal: Codex uses the account id of Pi's stored
      `openai-codex` OAuth credential (token claim first); Claude Code uses its
      own credential file's access token (so a token rotation conservatively
      invalidates). The context is captured before a read and re-derived at restore;
      any mismatch or unprovable context invalidates the entry instead of claiming
      isolation.
- [x] (Antigravity later superseded, see below.) Native Anthropic and Antigravity were not retained: no non-renewing local
      identity is available (Pi may renew OAuth on resolution; the CLI uses an
      inherited environment), so isolation cannot be proven. Antigravity opt-in and
      saved preferences are untouched.
- [x] Bounds: 16 entries (oldest evicted), 32 windows per entry, windows older than
      60 minutes or already past their reset are not restored.
- [x] Restore never suppresses an eligible startup read, changes a deadline, or
      overwrites newer data: it is skipped when a passive observation or any
      result already arrived, for disabled/collapsed-off providers, and after
      stop/reload (generation guard). A retired controller's late result records
      nothing. Authentication failures forget the entry; other failures keep it and
      the failure state is shown over the retained windows.
- [x] Focused mocked lifecycle tests (no network, credentials or Git delivery):
      `test/quota-memory.test.cjs` covers reload within the gap (no request,
      original timestamps, failure shown over retained windows), eligible reads
      replacing, auth/account/scope invalidation, authentication-failure forgetting,
      passive precedence, off providers, a retired late result, stop, bounds and
      registry versioning. 118 focused tests, typecheck, ESLint and Prettier passed.
      The earlier startup/diagnostics statements "no quota cache" and "no quota
      values restored" describe those scopes and are superseded by this section.
      Production TUI acceptance and real Pi `/reload` behavior are not claimed.

### Latest decisions after critical review (retention binding)

These supersede the "context is captured before a read" wording above.

- [x] Context is bound to the credential the request **actually used**, not a
      separate pre-read: the reader digests the token (Claude Code) or the account id
      of the resolved token/account pair (Codex) it sent, and returns it as an
      optional opaque `authContext` on the success `PollOutcome` (validated as a
      64-hex digest, success-only, never displayed, never in diagnostics; the
      scheduler's re-sanitization preserves it).
- [x] A read is stored only if that digest equals the **current** non-renewing
      identity re-derived after the request (Codex: Pi's stored `openai-codex`
      credential; Claude Code: its credential file). Unknown, divergent (resolved
      account differs from the stored one) or changed-during-request identity
      fails closed and forgets the entry. Restore re-derives the same stored
      identity only; it never calls `getProviderAuth`, which may renew tokens.
- [x] Retained data is the latest accepted value per window (pool + kind), merged
      by newest `observedAt`, built **after** race filtering: windows a passive
      response superseded are not stored from the read. Failed, cancelled or
      rejected polls store nothing; authentication failure still forgets.
- [x] Passive updates are retained only when `observed()` receives a proof digest
      that still matches the current identity. No call site can prove which
      credential a passive response used (Pi message/header events carry none), so
      today every passive update instead drops the windows it superseded (all of
      them when its content is opaque) so a reload never restores an older value.
- [x] Tests (`test/quota-memory.test.cjs`): resolved-vs-stored account mismatch,
      credential change during a request (Claude Code and Codex), passive race
      plus reload (Claude Code and Codex), proof-gated passive retention at runtime
      level, per-window merge/drop, and opaque auth-context validation.
- [x] Asynchronous ownership: every memory mutation is versioned. The store keeps
      a shared per scope/provider change counter (bumped by store, merge, drop,
      forget, invalidation and eviction; pruned records read above earlier ticks),
      and each runtime keeps a local per-provider counter advanced by passive
      supersede, authentication forget and stop. Retention captures both, awaits the
      current context, then mutates synchronously only if this runtime is not
      stopped and neither counter moved; otherwise it does nothing (including a
      delayed forget). Supersede drops synchronously outside the retention queue and
      invalidates pending retention; restore uses the same guards. A stopped old
      controller therefore cannot merge into or forget a newer runtime's entry.
      Deterministic tests hold the context promise across a passive update, an
      authentication forget, another runtime's mutation, and shutdown plus a new
      runtime (delayed merge and delayed forget), and cover version/eviction/pruning.
- [x] Antigravity retention is now implemented under the owner-approved
      simplification below (single account per process); the investigation that
      follows explains why no verified identity exists. Investigated without live
      calls or private files: the documented standalone `/usage` JSON result
      (`status`, `command.name=usage`, `command.data.groups[].buckets`, token
      counters) and `parseAntigravity` expose no account/email/identity
      field, and the CLI inherits the process environment with no non-renewing local
      identity source. Concrete gap: an account identifier in the `/usage` output
      (or a documented read-only `agy` identity command) is needed; until the owner
      confirms one, no identity is guessed.

Final independent review of the Codex and Claude Code retention work: **PASS**;
the reviewer ran 26 focused tests, and 56 focused tests plus typecheck, lint and
format checks passed in final validation. These are synthetic checks, not production
TUI or real reload acceptance. The requested retention scope is only partially
implemented at that review: Antigravity's retention was pending a proven account
identity (superseded below); Native Anthropic is excluded. No scheduling gaps or
network behavior changed.

### Owner-approved Antigravity retention (single account per process)

Supersedes the "Antigravity not retained" statements above. The owner approved
this simplification: assume **one Antigravity account per Pi process**, with no
verified identity.

- [x] Same bounded process memory, original `observedAt`/source, current
      scheduling rules (3 min active / 20 min idle untouched); restore at `/reload`
      with no extra CLI call and no gap change.
- [x] Scope is agent directory plus provider; the context is a constant explicit
      marker digest (`antigravity` / `single-account-per-process`), never claimed as
      verified identity. Codex and Claude Code keep their actual authentication
      verification unchanged.
- [x] Respects opt-in: not restored when disabled; opting out (at start or by a
      preference change) forgets the entry, invalidates pending retention, and a
      read finishing afterwards is not kept. Process exit clears memory naturally.
- [x] Retired controllers cannot write (existing stop/version guards); passive
      updates are never applied to Antigravity, so none can be clobbered.
- [x] Limitation documented: switching accounts requires closing and reopening Pi.
- [x] Tests: `test/antigravity-memory.test.cjs` (reload within the gap with no
      spawn, eligible read replacing, disabled/opt-out forgetting, scope separation,
      retired late result, runtime disable, and deterministic disable/re-enable
      while a read is in flight). 32 quota-memory + antigravity tests and
      48 runtime/wiring/lifecycle tests, typecheck, ESLint and Prettier passed.
      Note: this section was written after the implementation, not before.
- [x] Independent review: **PASS**, with a test gap identified for disabling and
      re-enabling during an in-flight read. The subsequent deterministic test
      closes that gap; seven Antigravity memory tests passed. No implementation
      bug was identified.
- [x] Owner confirmed production functionality and release readiness; no separate
      real `/reload` test result was supplied.

## Owner-authorized 1.0.0 local release preparation

The owner confirmed privately that the original author gave permission to use the
upstream work under MIT, and authorized public release: Git now, npm later. The
underlying evidence is held privately and is not published here. The only
author-requested attribution is thanks plus the upstream link at the end of the README.

- [x] Package metadata: version 1.0.0, `MIT`, repository/homepage/bugs for
      `nanonoir/pi-subscription-panel`, description for the four providers;
      `private: true` kept until npm publication is separately and explicitly
      authorized. Lockfile metadata updated; no dependency changes.
- [x] `LICENSE` (MIT, copyright nanonoir for this project's contributions; upstream
      copyrights are preserved as known and none are invented), README final
      acknowledgement, provenance, and changelog 1.0.0 entry.
- [x] Reconcile the old "unverified permission / private-only" statements.
- [x] Local preparation completed; subsequent Git delivery was separately authorized.

## Implementation state before owner acceptance

The implementation provides remaining-only bars and percentages, compact window
countdowns without a redundant reset label, and a Claude waiting state. The
`/subscriptions` menu offers Antigravity refresh opt-in; Atelier Display remains
the separate visibility control. At this point the loaded-copy discrepancy had not
been identified in the owner's production TUI.

Claude Code's startup and scheduled reader uses only its local credential file,
with a five-minute minimum gap, no credential fallback, token refresh or inference.
Ordinary response observations remain supported and take precedence over older
in-flight windows. Manual retry is available.

Independent reviews passed for the visual changes and the Claude source/race
handling. The final independent review passed after multi-pool, mixed-freshness,
and overflow fixes. The startup/reload correction and its final review are recorded
above. An earlier implementer run of `npm run check`
passed 202 tests, but exceeded the feature-branch policy against full suites; it
was not repeated during closure.
The one authorized live probe above is source evidence, not TUI acceptance or
authorization for further live calls. At that point production acceptance and
identification of the old single-panel loaded copy remained pending; the later owner
acceptance and Git authorization are recorded below.

# Authorized 1.0.0 Git delivery

The owner approved three chained PRs targeting main in order: scheduler/outcome
foundation, integrated runtime/presentation/tests, and release metadata. The owner
explicitly approved the size exception for PR 2 (+4668/-253 authored lines at
approval). Preserve the complete working result in a local snapshot commit, copy
whole files into each branch, validate intermediate trees, and merge with ancestry
preserved. Git push, PR creation, merges, v1.0.0 tag and GitHub Release are authorized.
Do not publish npm; keep private:true pending the owner's installation validation.
The owner confirmed production functionality and release readiness; do not require
another manual acceptance gate. Record actual CI and delivery results at closure.

## Implementation Outcome

### Implemented

The panel presentation, provider refresh controls and diagnostics, and bounded
reload retention were implemented and documented as described above. Release
metadata, MIT licensing and attribution were prepared locally; npm remains private.

### Deviations from Design

Reload retention superseded the original no-quota-cache restriction: it uses bounded
process-local memory with credential-bound Codex and Claude Code entries and the
owner-approved single-account-per-process assumption for Antigravity. Native
Anthropic retention is excluded. Atelier Display controls visibility separately
from Antigravity refresh opt-in. The old loaded copy was not identified; the owner
accepted the functioning result without another acceptance gate.

### Validation

Independent reviews passed, including the visual, diagnostics and retention scopes;
focused tests and checks are recorded above. The owner confirmed production
functionality and release readiness, without providing a separate real `/reload`
or real post-reload 4xx/5xx test result. PR [#16](https://github.com/nanonoir/pi-subscription-panel/pull/16)
merged to main with CI 169 passing; PR [#17](https://github.com/nanonoir/pi-subscription-panel/pull/17)
merged with CI 254 passing. The owner approved the PR 2 size exception
(+4668/-253 authored lines at approval).

### Follow-up

Git release preparation is in progress: PR 3, the `v1.0.0` tag and GitHub Release
are not yet complete; final delivery URLs are pending. npm publication is excluded
until separately authorized. The previously observed Native Anthropic error cause
remains unknown; no fix is claimed.
