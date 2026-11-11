# Architecture

## Current runtime

Pi loads `extensions/index.ts` as its extension entry point. It composes the provider panel controller, refresh runtime and `/subscriptions` controls on TUI startup, and disposes them on shutdown. Explicit panel preferences persist; quota observations remain in memory, and the last successful Codex and Claude Code readings survive a reload in a process-local store (see below).

The extension reads the separately supplied Pi `openai-codex` OAuth for Codex quota only, using account metadata from the resolved token first and matched stored metadata as fallback. Models remain on `openai/{model}`. Claude Code uses its own local credential for read-only startup and scheduled usage requests, and also observes ordinary responses; native Anthropic OAuth remains a separate compatibility path. Claude Code never falls back to another credential or refreshes its token. The `/subscription-debug` command arms diagnostics for the next ordinary response; it does not initiate inference. Minimum gaps are 60 seconds for Codex, five minutes for Claude Code, and 30 minutes for native Anthropic; Antigravity polling is opt-in.

The extension depends on Pi's extension API and Atelier's panel API; `types/pi-atelier.d.ts` supplies a local compile-time declaration for the latter. Tests transpile the runtime into a VM and mock external interfaces, so they do not establish live TUI compatibility.

## Provider contract foundation

`extensions/quota-contracts.ts` defines the shared quota and adapter contracts.
Results keep independent pools and
per-window observation times/sources; display clamping does not alter raw finite
reported percentages. A Claude Code adapter observes ordinary response metadata
synchronously and may return no update. Only polling-capable provider contracts
expose `refresh()`. No acquisition, scheduling, or new UI is implemented by this module.

`extensions/provider-adapters.ts` adds pure Claude Code response parsing,
Antigravity report parsing, partial-observation merging, and age/staleness
projection. It has no subprocess or network execution; the controller uses it for
response observations. Claude diagnostics are checked against the actual assistant
provider; missing data cannot refresh another window's provenance.

`extensions/antigravity-cli.ts` isolates the opt-in standalone `/usage` transport.
It uses the existing `AGY_BIN`/PATH selection and inherited environment, with no
shell, ignored stdin/stderr, a one-MiB stdout cap, and a 35-second watchdog. Failure
settles without waiting for stream closure, destroys owned stdout, and signals
only the direct child; shared engines/unknown descendants are never terminated.
It is disabled by default; the refresh runtime invokes it only when opted in and eligible.

`extensions/preferences.ts` owns schema-1 global preferences at the reserved Pi
agent-directory path. Reads never write; explicit saves normalize known settings
and atomically replace a same-directory temporary file. Malformed/unreadable/future
schemas are read-only. Atomic replacement is not cross-session transactionality.

`extensions/quota-format.ts` supplies pure bounded-text, countdown, and freshness
formatting with caller-provided time and age threshold. It does not fetch data or
read the clock. Panel assembly and runtime composition supply its inputs.

`extensions/quota-presentation.ts` assembles bounded provider contributions from
quota results and explicit display options. Independent pools never become an
aggregate percentage. Empty/missing/invalid readings are explained without fake
bars, and provider-level stale/unknown warnings and errors precede expendable detail
so row truncation cannot conceal them. Collapsed panels list pool windows within
the 24-row contribution limit; mixed freshness is marked per window.
The panel controller derives each provider's stale threshold from its refresh gap. The production controller uses this renderer.

`extensions/subscription-actions.ts` owns explicit preference command/menu changes
and ordered saves. Opening/cancelling a menu does not write, stale selections are
guarded, and protected/failed saves are labelled session-only. It performs no quota
acquisition; the production entry point registers the controls.

`extensions/subscription-panels.ts` composes preferences/actions, response-driven
Claude parsing, partial observation state, and presentation into a lifecycle
controller. Generation guards cancel stale startup/menu work, and startup buffers
retain observations while preferences load. It registers no timers or provider
queries itself; the production entry point invokes it and owns the refresh runtime.

`extensions/refresh-scheduler.ts` and `extensions/refresh-runtime.ts` coordinate
polling, activity, retry deadlines and manual blocks. A process-realm registry holds
only scheduling metadata (including an allowlisted last-failure reason, validated
HTTP status and the separate gap, backoff and server deadlines, never raw errors);
the runtime exposes it read-only through `/subscriptions status`. Separate processes do not coordinate, and survival across
actual Pi reloads is not established. Stop/disable aborts supported work, with
exclusion retained until settlement (including the owned Antigravity child); stale
controllers cannot publish. Claude Code is a polling job when its reader is supplied;
newer passive response windows take precedence over an in-flight read and defer the next read.

`extensions/quota-memory.ts` is the owner-approved, memory-only retention of the
last successful pools across reload. It has its own versioned process registry,
separate from the scheduling registry, and is never written to disk or shared
across processes. Entries are bound to scope, provider and an opaque keyed digest of
the actual credential used (no tokens or account ids), verified against current
identity, bounded in count, windows and age, and invalidated when identity differs
or cannot be proven. Version and lifecycle guards prevent stale asynchronous
mutations. Unproven passive updates evict superseded retained windows rather than
restore older values. Restore preserves observation times and does not request,
change deadlines or suppress an eligible read. Native Anthropic is excluded.
Antigravity is retained under an owner-approved single-account-per-process
assumption (a constant marker, not a verified identity), only while opted in;
switching accounts requires closing and reopening Pi. See the
[refresh design](docs/design-docs/refresh-scheduling.md).

## Target versus current

The [PRD](docs/PRD.md) describes target requirements; the [Phase 5 design](docs/design-docs/refresh-scheduling.md) records refresh decisions. The [development guide](docs/DEVELOPMENT.md) records synthetic validation limits and the pending production TUI smoke procedure.
