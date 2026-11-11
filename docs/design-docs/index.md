# Design documents

- [Safe refresh scheduling](refresh-scheduling.md): process-local coordination, bounded in-memory quota retention, failure handling and manual retry boundaries. Codex, Claude Code and (under an owner-approved single-account-per-process assumption) Antigravity retention are implemented and synthetically validated; production acceptance remains pending.

The current system is described in [ARCHITECTURE.md](../../ARCHITECTURE.md);
the [development guide](../DEVELOPMENT.md) records implemented preferences and
current validation limits.
