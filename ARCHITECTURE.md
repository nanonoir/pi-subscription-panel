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

## Target versus current

The [PRD](docs/PRD.md) describes future adapters, interactive provider sections, settings, and refresh hardening. These are target requirements, not the current architecture. The [development guide](docs/DEVELOPMENT.md) records baseline limitations and the manual TUI smoke procedure.
