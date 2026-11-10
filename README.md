# Pi Subscription Panel

A read-only subscription usage panel for the [Pi](https://pi.dev/) TUI and
[Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier).

## Support

| Integration                    | Current behavior                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Codex                          | Reads real quota through the existing Pi **OpenAI Codex** OAuth session. Model execution keeps `openai/{model}` and its own login. |
| Claude Code / `pi-claude-code` | Updates after each ordinary response carrying valid quota metadata. No additional request or polling.                              |
| Antigravity bridge             | Existing CLI quota source; automatic refresh is implemented but disabled by default.                                               |
| Native Anthropic OAuth         | Separate optional compatibility panel; not the authentication source for Claude Code.                                              |

Panels default to **remaining** percentages, with reset countdowns and observation
age. Missing windows are explained without fabricated bars. Partial updates keep
the other window's actual age, and stale or failed readings are marked. Refresh
uses conservative minimum gaps and failure handling; actual production TUI acceptance
remains pending.

## Install and run locally

Use Node.js **22+**, npm, and your existing Pi + Pi Atelier installation.
Do not change model routing or install another CLI for this panel. Codex quota
reads use the additional official Pi OpenAI Codex session supplied by the owner,
not the direct-sharing token used by `/login openai`.

Load only **one** panel copy. Before enabling this checkout, use `pi config` to
disable the original `pi-subscription-limits` extension resources if present.
Keep your provider extensions, authentication, and Atelier enabled. Both panel
copies share the preserved `subscription:limits` ID and must not run together.

From the cloned repository directory, in a shell or Windows PowerShell:

```sh
npm ci
npm run check
pi install .
pi
```

Open Atelier **Settings → Display**, enable **Codex**, **Claude Code**, and
**Antigravity**, then choose **Save default**. The **Native Anthropic** panel is
optional. New contributions start hidden; unsaved Display drafts do not apply.
Atelier can hide whole panels if terminal height is insufficient: enlarge the
terminal or hide unneeded built-in panels. Native hide/reorder controls remain intact.

If you ran the earlier spike, exit that session and hide its **TEST** panels.
They contain fictional data and are not the production panels.

This is an unpublished development package (`0.1.0`), marked private. No npm
installation source is claimed. Source is available at
[nanonoir/pi-subscription-panel](https://github.com/nanonoir/pi-subscription-panel).

## Panel controls

Viewing enabled panels requires no command. `/subscriptions` opens optional
controls for independent detail expansion and used/remaining display:

```text
/subscriptions toggle codex
/subscriptions toggle claude-code
/subscriptions toggle antigravity
/subscriptions display remaining
/subscriptions display used
/subscriptions refresh antigravity on
/subscriptions refresh antigravity off
/subscriptions refresh collapsed on
/subscriptions refresh collapsed off
/subscriptions retry codex
/subscriptions retry antigravity
/subscriptions retry anthropic
```

Collapsing retains the heading and summary; it does not hide/unregister a panel,
delete quota data, or request quota. Preferences persist globally in
`getAgentDir()/subscription-panel.json`, normally `~/.pi/agent/subscription-panel.json`.
The file is written only after an explicit preference change. Protected/failed
saves are reported as session-only. These are command/menu controls, **not clickable headings**.

Antigravity refresh is opt-in. Refresh while collapsed is on by default and is a
separate preference; turning it off pauses polling for collapsed providers without
clearing backoff. Changing these settings or expanding a panel does not itself start
a read. Manual retry may start one, or report that it is deferred, in progress, or
disabled; it respects minimum gaps and server deadlines. Authentication failures
and indeterminate Antigravity failures pause automatic retries until manual retry.
After an account change, use reload and explicit retry as appropriate; automatic
account-change detection is not guaranteed.

## Data sources and limitations

- Codex: `https://chatgpt.com/backend-api/wham/usage`, using only Pi Codex OAuth
  and matching account metadata. A single owner-authorized read returned both
  five-hour and weekly percentages/resets; the direct-sharing `openai` probe returned 401.
- Claude Code: its ordinary response's `claude-code.rate-limit` diagnostic.
  Aggregate window fields are internal and optional; missing data is never estimated.
- Native Anthropic: preserved `https://api.anthropic.com/api/oauth/usage` path.
- Antigravity: existing CLI `/usage` source; scheduled only after explicit opt-in.

Usage endpoints are undocumented interfaces, not guaranteed public APIs. Codex
has a 60-second minimum gap; native Anthropic has a 30-minute gap. Antigravity
has minimum gaps of three minutes when recently active and 20 minutes when idle.
HTTP requests reject redirects and time out after ten seconds; 429 and recoverable
failures back off and honor `Retry-After`. Local ages/countdowns update each minute,
without querying Claude Code. The three-minute stale label is an observation-age
threshold, not a Claude polling interval or a guaranteed provider freshness value.

Coordination is process-realm local, not cross-process; actual Pi `/reload` sharing
has not been proven. Synthetic tests do not establish production TUI behavior.
Stopping or disabling supported work requests cancellation; exclusion remains until
settlement, including the owned Antigravity child, not shared engines or descendants.

No inference is generated to measure quota. Credentials/account IDs are not
displayed, persisted in panel preferences, or included in errors. Pi may renew
existing OAuth through its normal machinery. See [provider discovery](docs/references/provider-discovery.md)
for evidence and [the development guide](docs/DEVELOPMENT.md) for remaining checks.

## Development and origins

See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for commands, smoke checks, and limitations;
[CONTRIBUTING.md](CONTRIBUTING.md) describes change scope and delivery.

### Acknowledgements / Origins

This distribution is based on
[pi-subscription-limits](https://github.com/alexmarco/pi-subscription-limits),
originally developed by [Alexmarco](https://github.com/alexmarco), and is used with
the author's explicit permission, as reported by this project's owner. The original
implementation, tests, and [upstream changelog](docs/UPSTREAM_CHANGELOG.md) retain
their attribution.

Underlying permission evidence and npm redistribution/relicensing scope still need
verification before publication. No new license grant is asserted.
See [PROVENANCE.md](docs/PROVENANCE.md) for the record and distribution blockers.
