# PRD — Pi Subscription Panel

**Status:** Draft for implementation

**Target:** Pi Coding Agent + Pi Atelier

**Origin:** Authorized copy of [`alexmarco/pi-subscription-limits`](https://github.com/alexmarco/pi-subscription-limits)

**Primary objective:** A compact, trustworthy, read-only subscription quota panel for Pi Atelier, supporting the user's existing Codex, Claude Code CLI, and Antigravity bridge integrations.

## 1. Product principles

1. **Preserve the working harness.** Do not replace, install, remove, reauthenticate, or modify the existing `openai-codex`, `pi-claude-code`, or Antigravity bridge providers.
2. **Read only.** Never write credentials, change selected models, intercept prompts, inject tool calls, or initiate model inference to measure quotas.
3. **Truthful metrics.** Distinguish reported values from estimates and missing data. Never infer a percentage from token usage or show fabricated zeros.
4. **Low overhead.** No polling loops that block Pi, no unnecessary processes, and no duplicate requests across active Pi sessions where coordination is feasible.
5. **Atelier-native.** Use Pi Atelier's documented sidebar contribution API and retain its upstream updates. Do not fork or patch Atelier unless an interactive requirement proves impossible with the public API.
6. **Attribution and distribution.** Keep original attribution and notices. The original author has granted permission to copy, modify and republish with attribution, as reported by the project owner. Preserve a record of that permission and verify that it includes npm redistribution; do not assume that the absence of a license means unrestricted public-domain use.

## 2. Scope

### In scope

- Codex subscription quota via the existing Pi `openai-codex` login.
- Claude Code subscription quota using an authorized read-only mechanism associated with the existing `pi-claude-code` / Claude Code CLI installation, **not** native Pi Anthropic OAuth.
- Google Antigravity quota associated with the **exact installed Antigravity bridge package**, with no replacement provider or authentication flow.
- Five-hour and weekly windows **when the provider actually reports them**, percent consumed/remaining, reset times, data freshness, and unavailable/error states.
- A right-side Atelier panel with independently collapsible provider sections, persisted preferences, and responsive layout.
- Configurable refresh scheduling and safe rate-limit behavior.
- Automated tests for parsing, scheduling, preference persistence, and provider-independent UI state.
- User-facing README, package metadata, original author acknowledgements, and installation instructions.

### Out of scope

- Subscription purchasing, switching accounts, credential migration, authentication management, model routing, automatic fallback, quota bypass, or pooled accounts.
- Automatic submission of any prompt solely to trigger quota updates.
- Publishing the package, creating a GitHub PR, or committing implementation changes without an explicit phase instruction.
- Claiming Google's or Anthropic's third-party integrations are officially endorsed or ban-proof.

## 3. Target UI and behavior

The Pi Atelier sidebar should include a **Subscriptions** area containing three sections, independently expandable/collapsible:

- **Codex** — collapsed heading: provider name + concise quota summary if available. Expanded: 5h / 1w bars, remaining percentage, reset countdown, freshness.
- **Claude Code** — same behavior; display `Unavailable` or `Awaiting usage data` when no supported read-only source exists.
- **Antigravity** — same behavior, respecting that the service may expose multiple distinct quota pools; **never merge independent pools into a single misleading percentage**.

Requirements:

1. A provider header remains visible while collapsed. Collapsing affects rendering only; it does not delete usage state.
2. Each provider has independent expansion state. Default: all expanded on first launch; user preference persists globally across sessions.
3. Progress colors are semantic and accessible in dark and no-color modes. Clearly label whether bars represent **remaining** or **used** percentages; default to **remaining**.
4. Display `5h` and `1w` only if those windows exist; otherwise show an explanatory unavailable state (not a 0% bar).
5. Show reset countdown from an absolute reset timestamp; countdown updates locally without an HTTP request.
6. Each provider shows the age of its last successful reading; stale data must be marked.
7. Avoid overflowing narrow sidebars. Honor Atelier layout limits and resizing; no unsolicited global keyboard shortcuts.
8. Do not assume `registerSidebarPanel()` provides clickable rows. Investigate actual API, keyboard routing and event registration before choosing accordion implementation.

### Accordion feasibility gate

Before implementing collapsible sections, create a minimal spike proving an actual interaction inside Pi's TUI. Explore, in order:

A. Documented Atelier contributed-panel interaction capabilities, if any.

B. Three separate contributed provider panels controlled by an explicit Pi command such as `/subscriptions toggle claude` (technically viable fallback, **not** equivalent to a clickable accordion).

C. A small upstream-compatible Atelier API contribution (preferred if clickable accordion is mandatory and impossible through public APIs).

**Acceptance rule:** Do not claim clickable accordion completion if only hide/show commands or static indicators work. Record the trade-off; obtain approval before modifying or forking Atelier. Preserve the global ability to hide/reorder panels in Atelier Settings → Display.

## 4. Provider integrations

All adapters must implement a shared interface conceptually equivalent to:

```ts
type QuotaWindow = {
  kind: "5h" | "1w" | string;
  remainingPercent: number;
  resetsAt?: string;
};

type QuotaResult = {
  providerId: "codex" | "claude-code" | "antigravity";
  availability: "ready" | "waiting" | "unavailable" | "error";
  windows: QuotaWindow[];
  observedAt?: string;
  source:
    "response-event" | "official-cli" | "read-only-endpoint" | "local-cache";
  stale?: boolean;
  detail?: string;
  retryAt?: string;
};
```

Implementation can improve types after source verification; all percentages must be validated and clamped for display without corrupting raw diagnostics.

### Codex

- Preserve and regression-test original `openai-codex` quota acquisition behavior.
- Favor Pi's existing OAuth session and quota response headers. Do not use the separate `openai` ChatGPT login as an equivalent to `openai-codex` unless verified.
- Avoid storing OAuth tokens or account identifiers in panel state.

### Claude Code (`pi-claude-code`)

- Inspect the _installed_ extension's exact code, provider id, exposed events and metadata; inspect installed Claude Code CLI's documented usage/status surfaces.
- **Approved refresh behavior:** inspect quota metadata after every ordinary Claude Code response and update each window for which valid reported data is present. Do not throttle these message-driven updates to a three-minute interval: they cause no additional provider request.
- Use the existing extension's `claude-code.rate-limit` message diagnostic. Its optional internal `unifiedWindows` fields may report actual five-hour/weekly utilization and reset timestamps; the owner accepts this compatibility risk. Validate fields, fail closed on schema changes, and never infer missing percentages from token counts or duplicate the limiting window into both windows.
- Do not perform scheduled, startup, idle, or background quota queries for Claude Code. No extra CLI invocation, usage-endpoint request, status-line configuration change, or inference probe is authorized by this behavior. A different source requires a new owner decision.
- Before the first valid reading, show `Awaiting usage data` or unavailable. If a response omits quota metadata or a window, retain the last valid reading for that window, preserve its observation timestamp, and show its age/staleness. No Claude activity means no fresh quota reading. Reset countdowns continue locally without a provider request.
- Never silently switch to native Pi `anthropic` `/login` or to `pi-claude-bridge`.
- If no safe compatible signal is found, show a truthful `Unsupported / waiting for data` state and deliver the rest of the extension.

### Antigravity bridge

- First identify the **exact installed package** and engine (`stream-json`, ACP, or other), provider id, supported quota/status events and any official CLI status interface.
- Explore whether the bridge exposes account/provider quota versus per-request token estimates. Keep these metrics separate.
- Do not import credentials from a different `pi-antigravity` provider or assume the Cloud Code API credential format applies to a CLI/ACP bridge.
- Do not introduce a third-party Google OAuth client, alternate auth plugin, quota-bypass or new sign-in.
- If quota is not available, report `Unavailable` rather than estimating subscription percentage.

## 5. Refresh policy

**Goal:** a visually current dashboard without unnecessary requests. Claude Code is strictly **message-driven**: inspect every ordinary response, without a polling interval or extra quota request. For providers supporting authorized read-only polling, target 3-minute freshness during active sessions **where supported**, not a guaranteed API request interval. Use one reusable activity-aware scheduler for polling-capable adapters; Claude Code must not schedule quota queries through it. Never use inference as a quota probe.

- Update reset countdowns locally every 60 seconds (no network calls).
- Apply valid quota metadata immediately after every ordinary provider response. For Claude Code this is the only approved acquisition path, with no three-minute throttle; processing a response is not a separate quota query.
- Use at most one in-flight quota request per provider and coordinate across sessions where practical.
- Suggested initial **configurable experimental defaults** (subject to adapter/source validation):
  - Codex: 60 seconds while active, or preserve upstream behavior if no issue is observed.
  - Claude Code: **response-event only**. Inspect each normal response; no active/idle polling, startup refresh, or timer-based request. Keep the last reading's actual age when no new quota arrives.
  - Antigravity: the owner approved **configurable, opt-in** refresh using the existing CLI's standalone `/usage` command following a successful bounded validation. Use the reusable activity-aware scheduler with **3 minutes minimum between active polling attempts** and **20 minutes while idle**, with independent backoff. Each attempt starts a process and contacts the backend; no official safe polling threshold has been established. Keep automatic polling disabled until explicitly opted in; never substitute inference or a different authentication flow.
- Define activity explicitly (e.g. a turn or relevant provider response within the past 10 minutes); do not reset the polling interval on every UI repaint. The 3-minute value is a **minimum gap**, not permission to query endpoints that do not support polling.
- Track `lastSuccess`, `lastAttempt`, `nextEligibleRefresh`, `inFlight`, and `lastError` per provider.
- Respect `Retry-After`, HTTP 429, endpoint-specific backoff, and exponential backoff with jitter for recoverable failures. Never poll faster because of a failure. On 401/403, stop automated retries until user action or credential change.
- Avoid repeated network requests after `/reload`, model switching, multiple Pi TUI instances or accordion opening.
- **Do not** represent a private/undocumented endpoint as having an official safe rate-limit threshold; document observed results and use conservative defaults when unknown.
- A collapsed provider should not trigger extra requests just because it was toggled. Keeping or pausing background refresh while collapsed is configurable and must not be conflated with its expanded state.

## 6. Configuration

Global config in the Pi agent configuration directory (filename finalized in Phase 1), with explicit schema, safe defaults and migration policy.

Proposed settings (illustrative; not assumed to exist in the current code):

```json
{
  "displayMode": "remaining",
  "expandedProviders": ["codex", "claude-code", "antigravity"],
  "refresh": {
    "codexSeconds": 60,
    "claude": { "mode": "response-event" },
    "antigravity": { "mode": "off", "activeSeconds": 180, "idleSeconds": 1200 }
  }
}
```

No secrets or personal tokens in the configuration. Validate invalid and partial settings; retain backward compatibility where possible.

## 7. Phased implementation and commit gates

### Phase 1 — Repository foundation and **FIRST COMMIT** (mandatory first deliverable)

**Do this phase only when first assigned. Do not implement new provider integrations or publish to npm yet.**

1. Audit copied files, dependencies, package scripts, current tests, README, git status, and original attribution.
2. Rename package/project, README title, description, keywords, repo/homepage/bugs fields and documentation to the new independent project identity. Use an owner-approved package name; don't assume npm ownership or availability.
3. Replace Alexmarco's README as the project's own README, describing current baseline behavior honestly; explicitly label planned Claude Code / Antigravity support as **planned**, not implemented.
4. Add an English **Acknowledgements / Origins** section naming Alexmarco, linking the original repo, stating that this distribution is based on the original and used with the author's explicit permission. Preserve author credits and relevant original notices.
5. Verify permission scope before adding a new license declaration that would purport to license the copied code. Do not add an unverified `MIT` license to original material merely because the owner described it as "free".
6. Create `docs/PRD.md` (this specification) and a compact `docs/DEVELOPMENT.md` with local commands and known architectural limitations.
7. Keep working baseline intact: ensure `pi.extensions`, Atelier dependency compatibility, `npm ci`, typecheck, lint, and current tests work. Fix only reproducible baseline issues and explain changes.
8. Add/confirm `.gitignore` protects `node_modules`, generated files, caches, local logs and any secrets; do not commit credentials or generated artifacts.
9. Confirm a fresh-clone install path from Pi and note Windows PowerShell examples.
10. Review `git diff --check`, `git status`, and the complete staged diff. Do **not** make the first commit until the user approves its content, unless the user explicitly instructs the agent to commit.

**Phase 1 acceptance:** An independent, clean, correctly attributed repository; honest README; documented PRD and development workflow; current Codex/Anthropic baseline unchanged; passing available checks; proposed initial commit summary.

Suggested commit: `chore: initialize subscription panel from authorized upstream source`

### Phase 2 — Discovery and adapter contracts

- Identify installed versions and exact provider ids for `pi-claude-code` and Antigravity bridge.
- Produce short findings on actual quota sources, supported refresh mechanisms, limitations, and risks; never invent access paths.
- Implement typed adapter interfaces and focused tests, preserving baseline Codex behavior.

### Phase 3 — Provider data adapters

- Add Claude Code and Antigravity adapters behind feature flags or safe capability detection.
- Preserve original Codex + optional native Anthropic paths.
- Add stale/unavailable/error states and tests, without new login flows.

### Phase 4 — UI, accordion and persistence

- Implement provider sections and responsive bars; complete feasibility gate for true interactive accordion.
- Persist expanded state; test in actual interactive terminal, including small windows and terminal resize.
- Ensure no additional network call occurs solely on expand/collapse.

### Phase 5 — Refresh tuning, hardening and release

- Test with controlled/recorded fixtures: 429, `Retry-After`, expired credentials, partial windows, concurrent sessions, offline mode, provider switch.
- Benchmark request frequency and overhead. Document safe defaults based on observed sources, not assumption.
- Prepare package name/version, MIT or other license **only if properly authorized**, provenance acknowledgements, changelog and npm/Pi publication steps.
- Publish and open upstream PR only with separate user authorization.

## 8. Definition of done

- Existing providers remain fully operational and are not reauthenticated or replaced.
- No quota check causes a model completion.
- Data is accurate or explicitly unavailable; stale results are identified.
- Five-hour/weekly fields display only when reported.
- Each provider can be independently collapsed, with durable state, or the documented feasibility gate produces an explicit blocker/required upstream API proposal; no fake interactive UI.
- Pi Atelier can independently update from upstream.
- Focused tests pass and baseline test suite is preserved.
- README documents supported installations and limitations honestly.
- Author's permission and attribution remain documented.
- Installation from local path, GitHub and (after publication) npm works without loading duplicate copies.

## 9. Implementation notes for the subagent

- Work phase by phase. On the first assignment, **execute Phase 1 only** and report a reviewable diff plus test results. Do not start Phase 2 in the same run.
- Favor small modules over the current large `extensions/index.ts` only when there is a concrete reason; keep Phase 1's changes minimal.
- Use minimal relevant tests for each change; do not run CPU-heavy browser/E2E suites without a demonstrated need.
- Do not push, create PRs, publish packages, or install/modify authentication plugins without authorization.
- Keep docs and code claims consistent; never describe future features as completed.

## 10. Reference repositories

- Original: https://github.com/alexmarco/pi-subscription-limits
- UI host: https://github.com/michaelmjhhhh/pi-atelier
- Existing Claude provider: https://github.com/earendil-works/pi-claude-code
- Alternative quota architecture: https://github.com/juanibiapina/pi-usage
- Claude refresh example: https://github.com/yasuhito/pi-usage
- Official Pi documentation: https://pi.dev/

**Discovery:** Phase 2 confirmed the installed `@estebanforge/pi-antigravity-bridge` package and validated one standalone CLI quota check. See [provider discovery](references/provider-discovery.md) for exact versions, source evidence, approved behavior, and remaining limitations. Do not assume other Antigravity packages expose the same capabilities.
