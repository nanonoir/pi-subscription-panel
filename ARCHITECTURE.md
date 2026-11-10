# Architecture

## Current runtime

Pi loads `extensions/index.ts` as its extension entry point. On a TUI session start it registers the `subscription:limits` sidebar panel through Pi Atelier, initializes an in-memory snapshot, and starts refreshes. Session shutdown disposes the panel and timer. No panel settings or quota state are persisted.

The extension reads existing Pi OAuth credentials for Codex and native Anthropic and makes read-only requests to their usage endpoints. It also consumes recognized quota headers from ordinary provider responses. Parsing, refresh scheduling, error handling, and panel rendering currently live in the same module. The `/subscription-debug` command arms diagnostics for the next ordinary response; it does not initiate inference.

The extension depends on Pi's extension API and Atelier's panel API; `types/pi-atelier.d.ts` supplies a local compile-time declaration for the latter. Tests transpile the runtime into a VM and mock external interfaces, so they do not establish live TUI compatibility.

## Provider contract foundation

`extensions/quota-contracts.ts` defines the shared quota and adapter contracts.
It is not yet wired into the entry point. Results keep independent pools and
per-window observation times/sources; display clamping does not alter raw finite
reported percentages. A Claude Code adapter observes ordinary response metadata
synchronously and may return no update. Only polling-capable provider contracts
expose `refresh()`. No acquisition, scheduling, or new UI is implemented by this module.

`extensions/provider-adapters.ts` adds pure Claude Code response parsing,
Antigravity report parsing, partial-observation merging, and age/staleness
projection. It has no subprocess or network execution and is not imported by the
entry point yet. Claude diagnostics are checked against the actual assistant
provider; missing data cannot refresh another window's provenance.

`extensions/antigravity-cli.ts` isolates the opt-in standalone `/usage` transport.
It uses the existing `AGY_BIN`/PATH selection and inherited environment, with no
shell, ignored stdin/stderr, a one-MiB stdout cap, and a 35-second watchdog. Failure
settles without waiting for stream closure, destroys owned stdout, and signals
only the direct child; shared engines/unknown descendants are never terminated.
It is disabled by default and not invoked by the entry point or any timer yet.

`extensions/preferences.ts` owns schema-1 global preferences at the reserved Pi
agent-directory path. Reads never write; explicit saves normalize known settings
and atomically replace a same-directory temporary file. Malformed/unreadable/future
schemas are read-only. Atomic replacement is not cross-session transactionality.
The entry point is not wired to this preferences module yet.

## Target versus current

The [PRD](docs/PRD.md) describes future adapters, interactive provider sections, settings, and refresh hardening. These are target requirements, not the current architecture. The [development guide](docs/DEVELOPMENT.md) records baseline limitations and the manual TUI smoke procedure.
