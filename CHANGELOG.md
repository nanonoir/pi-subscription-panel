# Changelog

This changelog tracks Pi Subscription Panel only.

## 1.0.0

First release, licensed under MIT (see [PROVENANCE.md](docs/PROVENANCE.md)). npm
publication is not yet performed; the package remains `private`.

- Read-only Pi Atelier panels for Codex, Claude Code, Antigravity, and native
  Anthropic OAuth, always showing remaining quota with reset countdowns.
- Codex quota through Pi's existing OpenAI Codex session; Claude Code quota through
  its own local credential; Antigravity through the CLI `/usage` source, scheduled
  only after opt-in from `/subscriptions`.
- Conservative refresh scheduling with minimum gaps, backoff, and `Retry-After`;
  provider-level stale labels and sanitized failure diagnostics via
  `/subscriptions status`.
- In-memory quota retention across `/reload`; nothing is written to disk.
- Limitations: Antigravity retention assumes a single account per Pi process (close
  and reopen Pi to switch accounts); native Anthropic is not retained; usage
  endpoints are undocumented; production TUI acceptance is not established.

The original project's releases are preserved separately in the
[upstream changelog](docs/UPSTREAM_CHANGELOG.md) for attribution and traceability.
