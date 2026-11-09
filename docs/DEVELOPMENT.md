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

The Phase 3 pure adapters are tested but **not wired into the running panel yet**.
`extensions/provider-adapters.ts` parses ordinary Claude Code response metadata
and Antigravity usage reports without I/O, and preserves per-window observation
age during partial updates. `test/provider-adapters.test.cjs` exercises these
boundaries using synthetic payloads. `extensions/antigravity-cli.ts` adds an explicit,
default-disabled CLI adapter; `test/antigravity-cli.test.cjs` tests opt-in behavior,
argv/bounds, sanitized errors, and the production runner with deterministic process
and timer doubles. No test starts the real CLI. Presentation and scheduling remain
later work; current user-visible support remains the baseline.

| Location                                                          | Responsibility                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `extensions/index.ts`                                             | Existing parsers, OAuth-backed read-only usage calls, refresh loop, response events, panel registration, diagnostic command. |
| `extensions/quota-contracts.ts`                                   | Standalone quota/adapter contracts and percentage validation; not wired into the runtime yet.                                |
| `types/pi-atelier.d.ts`                                           | Local declaration for the public Atelier contribution API; it is not runtime code.                                           |
| `test/usage.test.cjs`                                             | Transpiles the extension in a VM with mocked Pi, Atelier, fetch, and credentials.                                            |
| `test/quota-contracts.test.cjs` / `test/quota-contracts.types.ts` | Value and compile-time contract tests, including response-only Claude capabilities and per-window provenance.                |
| `docs/PRD.md`                                                     | Canonical requirements and phase acceptance gates.                                                                           |

Keep the single runtime module until a later phase has a concrete reason to split it.
Preserve `subscription:limits`, `subscription-limits` source, and `/subscription-debug`
for baseline compatibility. The package dependency remains `pi-atelier@^0.16.0`;
Pi agent/TUI peer ranges remain inherited `*`. Types are checked against the lockfile's
resolved peers, not every Pi version. The ambient Atelier declaration can mask API
drift; automated tests mock registration and do not prove live TUI compatibility.

## Manual smoke test (requires the owner's configured TUI)

For the pending Phase 4 command/menu feasibility gate, first use the isolated
[fictional-data interaction spike](references/atelier-spike.md). It does not run
the baseline usage calls described below, and no live result has been claimed.

1. Ensure only one copy is loaded; start Pi without changing providers or credentials.
2. Open `/atelier`, enable **Subscription** in **Settings → Display**, and verify
   Codex/Claude headings, reported used percentages/countdowns, or truthful error labels.
3. Hide/reorder the panel, resize the terminal, and confirm Atelier remains usable.
4. Optionally arm `/subscription-debug` before an **already intended** ordinary response.
   Expect only provider/status/header names, no header values, credentials, or prompt text.
5. Exit/restart or reload and confirm no duplicate panel is loaded.

This smoke test has **not** been run in Phase 1's noninteractive environment.
No authenticated endpoint was probed and no global Pi settings were modified.

## Future configuration decision (not implemented)

Reserve `subscription-panel.json` in Pi's agent configuration directory (normally
`~/.pi/agent/subscription-panel.json`) for later global preferences. Phase 1 does not
read, create, or write it. The [PRD configuration example](PRD.md#6-configuration)
is illustrative, not an accepted runtime schema today.

The later implementation must validate partial/invalid settings with safe defaults,
version its schema before migrations, keep secrets out, and preserve compatible known
preferences. There is no settings migration now because no settings loader exists.

## Baseline limitations and audit findings

The baseline queries usage at TUI session start, then approximately every minute
for Codex and every 30 minutes for native Anthropic. Countdown rendering updates
locally every minute. HTTP 429 defers retries by at least the normal interval,
five minutes, and any server-provided `Retry-After`.

This native Anthropic baseline is separate from the **approved, not yet implemented**
Claude Code behavior: update from every ordinary response carrying valid quota
metadata, with no extra/scheduled query or three-minute throttle. Missing data
keeps the previous observation's real age; reset countdowns update locally.
See [the canonical refresh policy](PRD.md#5-refresh-policy) for provider-specific rules.

- Native `anthropic` OAuth reporting is not `pi-claude-code` support. Antigravity is absent.
- No accordion, persisted preferences, freshness timestamp, activity-aware scheduling,
  per-provider in-flight guard, or cross-session deduplication exists yet.
- Missing windows currently include a zero-length progress field alongside `n/d`;
  text percentages can exceed 100 even though bars clamp. These PRD/UI gaps are deferred
  to the relevant later phases, not silently fixed during setup.
- Baseline retries are not disabled on 401/403. Undocumented endpoints may throttle
  or change. Preserve the existing behavior in this phase.
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
