# Installed provider discovery

Read-only investigation for [PRD Phase 2](../PRD.md#phase-2--discovery-and-adapter-contracts).
These are observations of the owner's installation, not minimum-version guarantees.
No credentials, private sessions, or logs were read; no inference session,
provider installation, or panel-initiated global configuration change was made.
The initial static investigation was followed by one owner-authorized Antigravity
CLI quota check, described below. Automatic refresh was separately approved as
configurable and opt-in; no polling has been enabled during discovery.

## Claude Code

- Extension: `@earendil-works/pi-claude-code` 0.1.0, installed Git commit
  `d5b5e04c314d3452d357174d16d10dda34daa2d2`.
- Provider `claude-code`; engine/API `claude-code-stream-json`
  (`src/model-catalog.ts:4–5`, `src/index.ts:5–6` in that extension).
- Global Claude Code package metadata reports 2.1.299. The runtime executable
  can differ through `PI_CLAUDE_CODE_COMMAND`; no invocation was performed here.
- `src/claude-cli.ts:1164–1177` retains the latest `rate_limit_info` from an ordinary
  CLI response. `src/stream.ts:389–406` attaches it to the assistant message's
  `diagnostics` as `claude-code.rate-limit`, including timestamp and raw details.
- The extension's `src/billing.ts:10–19` declares status/window/reset and overage
  fields but permits more fields. Token usage is not subscription percentage.
- Only the latest event is retained, and error/billing paths may prevent a final
  diagnostic. Do not claim complete simultaneous 5h/weekly coverage or infer
  percentages when utilization is absent. Native Pi `anthropic` is a separate path.
- `/claude-code-status` checks executable/login/plan readiness, not quota.

Official [Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/typescript)
describes rate-limit events, including optional utilization/reset fields.
[Status-line documentation](https://code.claude.com/docs/en/statusline) describes
five-hour/seven-day percentages, but exporting them here would require a separately
verified integration. Interactive `/usage` is not evidence of a machine-readable
polling API. No status-line/configuration modification is proposed without approval.

**Owner decision resolved:** use message-driven quota updates from every ordinary
Claude Code response carrying valid data. No three-minute throttle, scheduled
queries, startup/idle refresh, or extra CLI/HTTP requests. Missing metadata retains
the previous reading and its actual observation time; no reading means waiting or
unavailable, never fabricated zeros. Countdown updates are local, not fresh quota
observations. This is approved target behavior, not yet implemented. The canonical
policy is in [PRD provider integrations and refresh policy](../PRD.md#4-provider-integrations).

### Follow-up: both windows in the installed CLI schema

A targeted read-only inspection of the installed Claude Code 2.1.299 executable's
embedded event schema found optional `rate_limit_info.unifiedWindows.five_hour`
and `.seven_day`. Each carries `utilization` (a fraction, not a percentage) and
`resetsAt` (Unix epoch seconds). The schema describes this aggregate as internal;
it is not a stable public SDK guarantee. The existing extension's diagnostic passes
unknown fields through unchanged, so both windows can reach Pi without modifying
the provider. No live ordinary response has yet verified their presence for this
account. Absence must remain absence, not zero usage.

Top-level utilization/reset fields describe the currently limiting window and
must not be duplicated into both windows. The official statusline uses a different
shape (`used_percentage` and `resets_at`) and cannot be assumed to be this event's
schema. Any response-driven aggregate parser must tolerate missing fields, preserve raw
out-of-range values for diagnostics without unsafe display, and fail closed on
schema changes. The owner accepted this internal-field compatibility risk for
response-driven updates. Actual field presence on this account remains unverified;
no inference request may be sent solely to obtain a quota sample.

## Antigravity

- Exact package: `@estebanforge/pi-antigravity-bridge` 1.10.2.
- Provider `antigravity`; default engine `agy acp`, alternative `stream-json`
  (`extensions/index.ts:549`, `README.md:14–21`). A selective read of the bridge's
  engine setting confirms `acp`. The installed executable reports agy 1.5.3.
- `src/usage.ts:21–38,53–64` models account-level quota as named groups and buckets,
  with distinct window tags, remaining fractions, and optional reset times.
  Never merge independent pools or substitute per-turn/estimated token accounting.
- `/agy quota` invokes `agy --print /usage --output-format json` with
  `--print-timeout 30s`, a 35-second watchdog, and a 1 MiB output cap
  (`src/usage.ts:113–130`, `extensions/index.ts:1479–1503`). It starts a process
  using the existing CLI account, not a passive event or a replacement OAuth flow.
- Package comments report zero-token verification with agy 1.2.10. That is the
  author's claim, not a test performed on this installation.
- No passive quota event/cache was identified. The model catalog cache is not quota.
  `/agy doctor` provides health, not remaining subscription percentages.

Official [Antigravity usage documentation](https://antigravity.google/docs/cli/commands/usage/)
describes `/usage` as refreshing model configuration and quota from disk/backend.
Its [headless documentation](https://antigravity.google/docs/cli/headless/) says
slash commands such as `/usage` are handled internally, outside the model event
stream. It is still a network-backed CLI operation, not a side-effect-free local
cache read. Endpoint polling limits remain unverified; one invocation on the
installed CLI was validated below.

### Owner-authorized standalone validation

The owner approved one quota check. Resolved the existing executable via Windows
PATH (no `AGY_BIN` override), checked `--version`, and ran exactly one standalone
`--print /usage --output-format json --print-timeout 30s` command. stdin was ignored,
the parent timeout was 35 seconds, output was capped at 1 MiB, and no prompt/model
selection was supplied. Raw output was held in memory only, not saved to the repo.

Result: exit 0, `SUCCESS`, `command.name=usage`, about 5.9 seconds, no stderr,
`num_turns=0`, and every reported token counter zero. The response contained two
independent groups, each with weekly and five-hour remaining fractions and absolute
ISO reset timestamps. Live names, percentages, and reset values are intentionally
not stored here. This verifies the source on this executable for one invocation;
it does not establish a safe backend polling limit, prove all CLI side effects,
or guarantee future versions will behave identically.

**Owner decision resolved:** configurable, opt-in automatic CLI refresh is approved,
with the PRD's minimum three-minute active / twenty-minute idle intervals and
backoff. No official safe rate-limit threshold is claimed. No repeated quota
requests or automatic polling were enabled during discovery. Preserve separate
quota pools and fail closed on unsupported responses.

## Next gate

The owner has resolved the acquisition/refresh choices above. Typed contracts
must accommodate independent pools, optional observation provenance,
partial availability, and unavailable percentages without fabricated zeros.
The owner-observed Atelier interaction proof is recorded separately in
[Atelier feasibility](atelier-feasibility.md); it does not verify provider quota data.

## Pi 1.5 compatibility and new OpenAI subscription path

The owner's TUI screenshot reports Pi 1.5.0, provider `openai`, and subscription
billing. Read-only inspection of the installed global Pi/`pi-ai` 1.5.0 packages
confirmed that `getAgentDir`, `readStoredCredential`, provider auth resolution,
`message_end` diagnostics, and HTTP response metadata remain available. No account,
credentials, private session, or runtime model configuration was inspected.

Pi 1.5's public `pi-ai/dist/providers/openai.js` explicitly supports OpenAI ChatGPT
subscription OAuth through `https://api.openai.com/v1`, with token sharing described
in `auth/oauth/openai-chatgpt.js`. Its `openai-codex` provider is a distinct legacy
ChatGPT backend integration. Thus `openai` can legitimately use a subscription;
that does **not** prove its token is authorized for legacy `wham/usage` quota calls.

The existing panel's exact-provider credential and endpoint boundary remains
unchanged. Auth resolution can refresh credentials through Pi's existing machinery;
do not describe it as a guarantee of no SDK-managed credential writes.

HTTP `after_provider_response` has status/headers but no provider/model identity;
it does not establish WebSocket header coverage. No verified new-OpenAI subscription
quota schema or machine-readable usage endpoint was found. Per-turn tokens and
billing labels are not subscription percentages. Do not substitute credentials,
infer percentages, or generate inference solely to inspect quota.

**Owner decision pending:** retain the existing legacy quota path with an honest
unavailable state where the current login exposes no compatible quota, or investigate
another read-only source for the new `openai` path before adopting that fallback.
No auth/client/provider/model change or new quota probe has been performed.
