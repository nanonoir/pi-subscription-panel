# Safe refresh scheduling

## Decisions and scope

Scheduling stays outside parsing, presentation, and preference controls. Claude
Code now has an owner-approved startup and scheduled read with a five-minute minimum
gap, alongside unthrottled qualifying ordinary-response updates. Passive windows
supersede older in-flight data and defer the next read. `openai/{model}` activity can inform Codex quota
scheduling, but quota reads use only the owner-supplied Pi Codex OAuth session.
Native Anthropic remains a separate compatibility path, not Claude Code.

The owner approved two limitations explicitly:

- Coordination is **per Pi process**, including extension reload. Separate Pi
  processes can query independently; cross-process deduplication is not claimed.
- Antigravity CLI failures have no reliable HTTP classification. An indeterminate
  failure pauses its automatic refresh until explicit manual retry, retaining the
  last reading with age/error. Do not infer authentication or throttling from text.

Do not persist quota values, credentials, account identifiers, or hashes to disk or
share them across processes. The scheduling registry (process-shared) contains
scheduling/exclusion metadata only. While a provider waits with nothing to show,
the runtime tells the panel the exact next eligible time (a sanitized waiting state
with no quota values). Ticks synchronize any later retained Retry-After deadline;
the first tick after the applicable deadline reads without any model message. A
fresh start has no attempt history, so its first tick reads every enabled provider
independently of the selected model provider.

### In-memory retention across reload (owner-approved adjustment)

This supersedes the earlier "no shared quota-value cache / wait instead of
restoring" restriction. A separate store (`extensions/quota-memory.ts`, own
`Symbol.for(...quota-memory.v1)` registry, version-checked; a foreign version is
replaced, never trusted) keeps the last successful pools in process memory only:

- Never written to disk, never shared across processes, independent of the
  scheduling registry, which is unchanged.
- Keyed by agent-directory scope and provider, and bound to an opaque HMAC-SHA256
  digest (random per-process key, memory only) of the authentication context. No
  token, account id or reversible value is stored. Proof is derived from the
  credential actually used by the successful read and verified against current
  non-renewing identity before storage and at restore, without network or renewal.
  Codex uses the resolved token/account pair's account id, checked against Pi's
  stored `openai-codex` credential; Claude Code uses its credential file's access
  token, so rotation conservatively invalidates. A mismatch or unprovable context
  deletes the entry. Native Anthropic is excluded.
- Antigravity: the CLI output has no verified identity field, so the owner approved
  a **single-account-per-process assumption** instead. Its context is a constant,
  explicit marker digest, never a verified identity; scope (agent directory) and
  provider still separate entries. It reuses the same store, bounds, race guards
  and scheduling gaps (3 min active / 20 min idle, untouched); restore needs no CLI
  call. Retention is skipped and the entry is forgotten when Antigravity is not
  opted in (at start or on a preference change), and a read finishing after that is
  not kept. It ends with the process. Switching the Antigravity account requires
  closing and reopening Pi; a reload cannot detect it and would show the previous
  account's reading until the next eligible read replaces it.
- Bounded: 16 entries (oldest evicted), 32 windows per entry; windows observed more
  than 60 minutes ago or already past their reset are not restored.
- Restore shows the windows with their original `observedAt` and source (so
  freshness/stale labels stay truthful) and a retained failure on top. It makes no
  request, never alters a deadline, and never suppresses an eligible startup read,
  which replaces the retained values. It is skipped when a passive observation or
  any result arrived first, when the provider is off for refresh, when a block is
  retained, and after stop/reload (generation guard); a retired controller's late
  outcome records nothing. Authentication failures forget the entry; other failures
  keep it. Accepted windows merge by observation time after passive-race filtering.
  Passive windows require a matching current credential proof to be retained; current
  event sources cannot supply one, so they evict superseded retained windows instead
  (all windows for an opaque supersession). Shared store versions and runtime
  generation guards prevent delayed mutations or restores from overriding newer work.
- Account changes are detected only through the context above; the explicit
  reload/retry guidance still applies where no context is provable.

## Scheduler boundary

The engine accepts only polling-capable provider jobs, an injected clock/random
source, and result delivery. Root composition owns one minute-scale tick for local
rendering and acquisition eligibility; repaint, expansion and model selection do
not request quota or reset activity. Relevant ordinary provider responses within ten
minutes define activity in the current runtime, not UI repaint.

Keep presentation-facing `QuotaResult` separate from a sanitized poll outcome:
success, recoverable failure, authentication unavailable/rejected, indeterminate
CLI failure, or cancellation, plus known status/retry deadline when exposed.
Never parse arbitrary CLI stderr or human error strings to invent HTTP status.

Track `lastAttempt`, `lastSuccess`, `nextEligible`, `inFlight`, failure count,
last safe error, relevant activity and manual-retry block per provider. Anchor
minimum gaps to actual attempt starts. Apply the latest of the normal gap,
server `Retry-After`, and failure backoff. Jitter is nonnegative; cap exponential
growth, not a valid server deadline. Missing/malformed data is not success and
cannot refresh observation timestamps.

Retain the last failure only as an allowlisted reason code (`http`, `timeout`,
`network`, `query`, `format`, `session-unavailable`, `manual-retry`, `unknown`),
a validated HTTP status and its time; unrecognized values become `unknown`. Keep the
normal gap, backoff and server deadline separate. The effective deferral cause is the
latest deadline still in the future, with ties resolved server, then backoff, then
gap. A success clears the failure and both retry deadlines; a retired controller's
late outcome keeps only this metadata for a failure and nothing for a success. The
runtime may surface this read-only (reload state, `/subscriptions status`); it must
not cause a request.

Known HTTP 401/403 and unavailable authentication stop automatic retries; a missing
or unusable Claude Code credential is treated as a recoverable unavailable read. Unknown
Antigravity failures also stop as approved. Explicit retry clears a manual block
but respects minimum gaps and any known server retry deadline. It never logs in,
changes a model/provider, or causes inference. Repaint, expansion and `/reload`
do not clear the block. The UI must state when a request is deferred.

## Lifecycle and coordination

Use a versioned process registry with metadata keyed by agent-directory scope and
quota provider, not account identity. Verify that the actual extension loader uses
the same JS global realm before claiming reload survival. A job retains its
in-flight exclusion until bounded transport settlement, even after stop or reload.
Every delivery is generation-guarded; stale work cannot update a new controller.

Abort supported HTTP reads and the owned Antigravity child on stop/disable.
Normal Pi-managed OAuth renewal must settle safely; result invalidation alone is
not proof the operation stopped. Never kill shared engines or unknown processes.
No lease service, cross-process lock, disk cache or cross-process quota cache is
part of the approved implementation; the only quota-value store is the bounded
in-memory retention described above.

Collapsed state remains rendering preference. A separate refresh-while-collapsed
setting may pause acquisition, but toggling does not directly perform a read and
must preserve state and pending backoff. Defaults keep normal refresh independent
of expansion. Runtime preference changes update eligibility, not request history.

## Evidence and validation

Provider sources and live-probe limits are in
[provider discovery](../references/provider-discovery.md). A successful quota read
does not establish an official safe polling threshold. Antigravity remains opt-in.

Use fake-clock/deferred tests for minimum gaps, activity, 429/Retry-After,
authentication/manual blocks, jitter, cancellation, reload exclusion, Claude startup
and passive-response precedence, and zero repaint/toggle acquisition. Validate bounded transport cleanup separately.
Actual TUI persistence/resize and user-account data require separate observations;
do not call those proven by scheduling tests. External account changes have no
verified universal notification: document explicit reload/retry after account changes
rather than claiming automatic account detection.
