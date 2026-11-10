# Local development

Use Node.js 22+ and npm with an existing Pi + Pi Atelier installation. Do not install,
replace, or reauthenticate model providers for this phase. Start with [the README](../README.md#install-and-run-locally).

## Commands

| Command                                                       | Purpose                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm ci`                                                      | Reproduce the checked-in dependency tree.                     |
| `npm run typecheck`                                           | Check extension types without emitting files.                 |
| `npm run lint`                                                | Check TypeScript, JavaScript, and tests.                      |
| `npm test`                                                    | Run fast baseline and contract tests; no provider HTTP calls. |
| `node --test --test-name-pattern="Codex" test/usage.test.cjs` | Run a focused subset.                                         |
| `npm run format:check`                                        | Verify formatting, including docs and CI files.               |
| `npm run check`                                               | Run formatting, lint, types, and baseline unit tests.         |
| `npx --no-install prettier --write <file>`                    | Format an edited file using the installed formatter.          |

There is no build/server step: Pi loads `extensions/index.ts` through `pi.extensions`.
For a temporary run, use `pi -e ./extensions/index.ts` **instead of** installing/loading
another copy. For an installed local package, restart Pi after setup; use `/reload`
while iterating where supported by your Pi version. Never send a prompt just to probe quota.

## Architecture and boundaries

The production entry point composes the provider panels, preferences and
`/subscriptions` controls. `extensions/provider-adapters.ts` parses ordinary Claude
Code response metadata and Antigravity usage reports without I/O, preserving
per-window observation age during partial updates. `extensions/antigravity-cli.ts`
provides a default-disabled CLI adapter, but automatic acquisition is not invoked
before Phase 5. Adapter tests use synthetic payloads and deterministic process and
timer doubles; no test starts the real CLI.

The `quota-presentation.ts` renderer labels used/remaining values, retains independent pool identities and
per-window age, explains missing/non-finite data, and bounds rows to Atelier's
public limits. Its tests cover actual row truncation preserving the leading
stale/unknown marker; they do not replace a real narrow-terminal smoke test.

The production `subscription-panels.ts` controller composes those foundations.
Controller tests use real preferences/actions/adapters with injected file access
and a stubbed host/renderer, covering buffered startup observations, cancelled
loads, serialized-save/restart ordering, and independent controls. Six entry-point
integration tests exercise the real module graph with mocked external effects and
fake-file profiles; they do not establish actual TUI behavior.

| Location                                                          | Responsibility                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `extensions/index.ts`                                             | Runtime composition, OAuth-backed read-only usage calls, baseline refresh loop, response events and diagnostic command. |
| `extensions/quota-contracts.ts`                                   | Shared quota/adapter contracts and percentage validation.                                                               |
| `types/pi-atelier.d.ts`                                           | Local declaration for the public Atelier contribution API; it is not runtime code.                                      |
| `test/usage.test.cjs`                                             | Transpiles the extension in a VM with mocked Pi, Atelier, fetch, and credentials.                                       |
| `test/quota-contracts.test.cjs` / `test/quota-contracts.types.ts` | Value and compile-time contract tests, including response-only Claude capabilities and per-window provenance.           |
| `docs/PRD.md`                                                     | Canonical requirements and phase acceptance gates.                                                                      |

Preserve existing panel identifiers and `/subscription-debug` for compatibility.
The package dependency remains `pi-atelier@^0.16.0`;
Pi agent/TUI peer ranges remain inherited `*`. Types are checked against the lockfile's
resolved peers, not every Pi version. The ambient Atelier declaration can mask API
drift; automated tests mock registration and do not prove live TUI compatibility.

## Manual smoke test (requires the owner's configured TUI)

The owner already demonstrated the command/menu pathway using the isolated
[fictional-data interaction spike](references/atelier-spike.md). That does not
prove production persistence or resizing. The following production smoke remains
pending and can be combined with the final Phase 5 smoke.

1. Ensure only one copy is loaded; start Pi without changing providers or credentials.
2. Open `/atelier`, enable the provider panels in **Settings → Display**, choose
   **Save default**, and verify
   headings, reported percentages/countdowns, or truthful error labels.
3. Use `/subscriptions` to change independent expansion and display preferences;
   hide/reorder panels, resize the terminal, and confirm Atelier remains usable.
4. Optionally arm `/subscription-debug` before an **already intended** ordinary response.
   Expect only provider/status/header names, no header values, credentials, or prompt text.
5. Exit/restart or reload; confirm saved preferences persist and no duplicate panel is loaded.

The production smoke has not yet been completed. Owner-authorized source probes
are documented separately in [provider discovery](references/provider-discovery.md).

## Preferences

`extensions/preferences.ts` implements the [schema-1 configuration](PRD.md#6-configuration)
at `getAgentDir()/subscription-panel.json` (normally `~/.pi/agent/subscription-panel.json`).
It defaults to remaining percentages, expanded provider details, response-only
Claude Code, and disabled Antigravity acquisition. The age threshold is local
presentation state, not a quota-request interval.

Loading never writes. Explicit saves use an exclusive temporary file and atomic
replacement; malformed/unreadable/future-schema files are protected with generic
warnings. This is not a cross-session read/modify/write transaction. Tests override
the path and use disposable directories under the approved temp `opencode` root,
never the owner's agent configuration. The production controller loads and explicitly
saves these preferences; real TUI persistence remains to be verified.

## Current refresh limitations and historical Phase 1 audit findings

The current baseline queries usage at TUI session start, then approximately every 60 seconds
for Codex and every 30 minutes for native Anthropic. Countdown rendering updates
locally every minute. HTTP 429 defers retries by at least the normal interval,
five minutes, and any server-provided `Retry-After`.

This native Anthropic baseline is separate from the implemented
Claude Code behavior: update from every ordinary response carrying valid quota
metadata, with no extra/scheduled query or three-minute throttle. Missing data
keeps the previous observation's real age; reset countdowns update locally.
See [the canonical refresh policy](PRD.md#5-refresh-policy) for provider-specific rules.

- Native `anthropic` OAuth reporting is separate from Claude Code. Antigravity
  automatic acquisition, activity-aware scheduling and hardened retry handling are
  not implemented. Phase 5's approved design does not claim cross-process deduplication.
- Baseline retries are not disabled on 401/403. Undocumented endpoints may throttle
  or change; a successful probe does not establish a safe polling threshold.

The following are **historical Phase 1 audit findings**, not claims about the
current dependency tree or UI:

- Initial `npm ci` succeeded on Node 24.18.0 / npm 11.16.0. Lint, types, and all ten
  tests passed; formatting initially failed on copied files (including CRLF endings).
  `.gitattributes` and Prettier normalization make the checkout consistent.
- Initial install reported **12 dependency vulnerabilities (11 moderate, 1 high)**.
  `npm audit --omit=dev` reported three affected packages: the Pi agent peer,
  `minimatch`, and `undici` (high). These are inherited dependency-tree findings,
  not proof of exploitability in this panel. Dependency upgrades/forced audit fixes
  were not applied because they could change the preserved Pi runtime. Resolve and
  revalidate them before distribution; do not treat a passing check as a clean audit.
- npm also warned about deprecated `node-domexception` and unapproved lifecycle
  scripts in `@google/genai` and `protobufjs`; no extra script approval was granted.

See [PROVENANCE.md](PROVENANCE.md) for release blockers. No npm publish or release
workflow is enabled in this phase.
