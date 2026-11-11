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
provides the default-disabled CLI adapter, invoked by the refresh runtime when opted
in and eligible. Adapter tests use synthetic payloads and deterministic process and
timer doubles; no test starts the real CLI.

The `quota-presentation.ts` renderer shows remaining values, retains independent pool identities and
per-window age, explains missing/non-finite data, and bounds rows to Atelier's
public limits. Its tests cover actual row truncation preserving the leading
stale/unknown marker; they do not replace a real narrow-terminal smoke test.

The production `subscription-panels.ts` controller composes those foundations.
Controller tests use real preferences/actions/adapters with injected file access
and a stubbed host/renderer, covering buffered startup observations, cancelled
loads, serialized-save/restart ordering, and independent controls. Six entry-point
integration tests exercise the real module graph with mocked external effects and
fake-file profiles; they do not establish actual TUI behavior.

| Location                                                            | Responsibility                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `extensions/index.ts`                                               | Runtime composition, OAuth-backed read-only usage calls, refresh tick, response events and diagnostic command. |
| `extensions/refresh-scheduler.ts` / `extensions/refresh-runtime.ts` | Process-realm scheduling metadata, provider eligibility, cancellation and result delivery.                     |
| `extensions/quota-contracts.ts`                                     | Shared quota/adapter contracts and percentage validation.                                                      |
| `types/pi-atelier.d.ts`                                             | Local declaration for the public Atelier contribution API; it is not runtime code.                             |
| `test/usage.test.cjs`                                               | Transpiles the extension in a VM with mocked Pi, Atelier, fetch, and credentials.                              |
| `test/quota-contracts.test.cjs` / `test/quota-contracts.types.ts`   | Value and compile-time contract tests, including response-only Claude capabilities and per-window provenance.  |
| `docs/PRD.md`                                                       | Canonical requirements and phase acceptance gates.                                                             |

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
   headings, remaining percentages/countdowns without a redundant reset label,
   `(waiting refresh)` where applicable, or truthful error labels.
3. Use `/subscriptions` to change independent expansion and display preferences;
   hide/reorder panels, resize the terminal, and confirm Atelier remains usable.
4. Check the `/subscriptions` menu's opt-in Antigravity refresh control separately
   from Atelier Display visibility. Optionally arm `/subscription-debug` before an **already intended** ordinary response.
   Expect only provider/status/header names, no header values, credentials, or prompt text.
5. Exercise the opt-in and retry controls as appropriate with the owner; exit/restart
   or reload, confirm saved preferences persist and no duplicate panel is loaded.
   Verify actual reload behavior separately; a successful synthetic loader test is
   not proof that real Pi `/reload` shares the registry.

The production smoke has not yet been completed. Owner-authorized source probes
are documented separately in [provider discovery](references/provider-discovery.md).

## Preferences

`extensions/preferences.ts` implements the [schema-1 configuration](PRD.md#6-configuration)
at `getAgentDir()/subscription-panel.json` (normally `~/.pi/agent/subscription-panel.json`).
It defaults to remaining percentages, expanded provider details, and disabled
Antigravity acquisition. The legacy Claude response-event preference does not disable
the separately scheduled Claude Code reader. The age threshold is local
presentation state, not a quota-request interval.

Loading never writes. Explicit saves use an exclusive temporary file and atomic
replacement; malformed/unreadable/future-schema files are protected with generic
warnings. This is not a cross-session read/modify/write transaction. Tests override
the path and use disposable directories under the approved temp `opencode` root,
never the owner's agent configuration. The production controller loads and explicitly
saves these preferences; real TUI persistence remains to be verified.

## Refresh behavior and limitations

The scheduler checks eligibility at TUI startup and on a minute-scale tick, with
minimum attempt gaps of 60 seconds for Codex, five minutes for Claude Code, and 30 minutes for native Anthropic.
Antigravity is disabled by default; `/subscriptions refresh antigravity on` opts in
and `off` disables it. Its minimum gaps are three minutes after relevant recent
activity and 20 minutes when idle. Ordinary provider responses, not UI repaint,
record activity for ten minutes. Countdown rendering updates locally every minute.
HTTP 429 and recoverable failures apply backoff and honor server `Retry-After`.

This native Anthropic baseline is separate from Claude Code: its startup and
scheduled read uses only the existing Claude Code credential file, with no token
refresh or credential fallback. Ordinary responses carrying valid quota metadata
still update immediately; newer passive windows win over an in-flight read and defer
the next one. Missing data keeps the previous observation's real age; countdowns update locally.
See [the canonical refresh policy](PRD.md#5-refresh-policy) for provider-specific rules.

- Native `anthropic` OAuth reporting is separate from Claude Code. A 401/403 or
  unavailable authentication blocks automated retries; indeterminate Antigravity
  errors do likewise. `/subscriptions retry codex|claude-code|anthropic|antigravity` (choose one
  provider) clears a block when enabled, subject to gaps and server deadlines; a
  deferred retry runs on an eligible later tick. Repaint, expansion and reload do
  not intentionally clear blocks. After account changes, reload and explicitly retry
  as appropriate; automatic account detection is not guaranteed.
- `/subscriptions status` reports the registry's retained, sanitized scheduling
  metadata without any request, credential access or persistence. The reload
  "deferred" panel state uses the same data: the last failure (allowlisted reason
  and validated HTTP status) and the effective cause, the latest future deadline
  with ties resolved server deadline, then backoff, then minimum gap. A retired
  controller's late failure keeps only that metadata; a late success keeps nothing.
  Legacy failures without a retained safe reason, including blocked failures, are
  reported as unknown. Status prioritizes a manual-retry block over deadline
  eligibility; the listed deadlines still constrain the retry. A later success
  clears the failure, backoff and server deadline. Validation here
  is mocked; a real 4xx/5xx after reload is not exercised against production.
- After a reload the last successful Codex and Claude Code readings are shown again
  from process memory (original observation times, no request, gaps unchanged) when
  the authentication context is provably the same; otherwise nothing is restored.
  Antigravity is restored the same way under an owner-approved single-account-per-
  process assumption (not a verified identity) and only while opted in; disabling it
  discards the entry, and switching accounts requires closing and reopening Pi.
  Entries are bounded (16 entries, 32 windows, 60 minutes), never persisted and never
  shared across processes. Native Anthropic is not retained. Mocked
  loader tests (`test/quota-memory.test.cjs`) reload the module graph in a shared
  realm; these tests do not verify real Pi `/reload` behavior. The owner confirmed
  production functionality and release readiness without a separate reload result.
- `/subscriptions refresh collapsed off` pauses acquisition for collapsed providers;
  `on` (the default) keeps it enabled. This policy is independent of expansion and
  preserves backoff. Preference changes do not directly issue reads.
- Registry coordination is per shared process realm, not cross-process. The synthetic
  Jiti `evalModule` test shared `globalThis` and `Symbol.for`, but did not exercise
  Pi's real `jiti.import` or `/reload`. No actual reload guarantee follows.
- Stop/disable aborts supported requests and signals only the owned Antigravity
  child; exclusion persists until settlement, including child termination. Shared
  engines and unknown descendants are not terminated. Stale work cannot publish.
  Undocumented endpoints may change; one successful probe does not establish a safe
  polling threshold.

## Historical Phase 1 audit findings

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

See [PROVENANCE.md](PROVENANCE.md) for distribution status. No npm publish or release
workflow is enabled; the package stays `private` until npm publication is explicitly
requested.
