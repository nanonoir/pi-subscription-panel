# Safe refresh scheduling

## Decisions and scope

Scheduling stays outside parsing, presentation, and preference controls. Claude
Code is structurally excluded: every qualifying ordinary response updates it,
without a polling interval. `openai/{model}` activity can inform Codex quota
scheduling, but quota reads use only the owner-supplied Pi Codex OAuth session.
Native Anthropic remains a separate compatibility path, not Claude Code.

The owner approved two limitations explicitly:

- Coordination is **per Pi process**, including extension reload. Separate Pi
  processes can query independently; cross-process deduplication is not claimed.
- Antigravity CLI failures have no reliable HTTP classification. An indeterminate
  failure pauses its automatic refresh until explicit manual retry, retaining the
  last reading with age/error. Do not infer authentication or throttling from text.

Do not persist/share quota values, credentials, account identifiers, or hashes in a
coordination cache. Process-shared state contains scheduling/exclusion metadata
only. A reload may therefore wait for the next eligible read instead of restoring
an unverified previous-account quota snapshot.

## Scheduler boundary

The engine accepts only polling-capable provider jobs, an injected clock/random
source, and result delivery. Root composition owns one minute-scale tick for local
rendering and acquisition eligibility; repaint, expansion and model selection do
not request quota or reset activity. Relevant ordinary provider turns/responses
within ten minutes define activity, not UI repaint.

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

Known HTTP 401/403 and unavailable authentication stop automatic retries. Unknown
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
No new cache/lease service, global quota-value cache, or cross-process lock is part
of the approved implementation.

Collapsed state remains rendering preference. A separate refresh-while-collapsed
setting may pause acquisition, but toggling does not directly perform a read and
must preserve state and pending backoff. Defaults keep normal refresh independent
of expansion. Runtime preference changes update eligibility, not request history.

## Evidence and validation

Provider sources and live-probe limits are in
[provider discovery](../references/provider-discovery.md). A successful quota read
does not establish an official safe polling threshold. Antigravity remains opt-in.

Use fake-clock/deferred tests for minimum gaps, activity, 429/Retry-After,
authentication/manual blocks, jitter, cancellation, reload exclusion, and zero
Claude/repaint/toggle acquisition. Validate bounded transport cleanup separately.
Actual TUI persistence/resize and user-account data require separate observations;
do not call those proven by scheduling tests. External account changes have no
verified universal notification: document explicit reload/retry after account changes
rather than claiming automatic account detection.
