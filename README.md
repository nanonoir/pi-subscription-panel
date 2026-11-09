# Pi Subscription Panel

A read-only subscription usage panel for the [Pi](https://pi.dev/) TUI and
[Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier).

## Support

| Integration                        | Status                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Codex                              | Uses the existing Pi `openai-codex` OAuth session.                                             |
| Native Anthropic OAuth             | Preserves the upstream `anthropic` quota integration. This is **not Claude Code CLI support**. |
| Claude Code CLI / `pi-claude-code` | **Planned**, not implemented or verified.                                                      |
| Antigravity bridge                 | **Planned**, not implemented.                                                                  |

The **Subscription** panel displays **used** percentages and local reset countdowns
for reported 5-hour/weekly windows. Missing values show `n/d`; failed refreshes retain
previous values with an error marker. Some existing UI labels are Spanish.

Remaining-percentage views, independent collapsible sections, freshness indicators,
and configurable refresh are planned, not available yet. See [the PRD](docs/PRD.md).

## Install and run locally

Use Node.js **22+**, npm, and an existing Pi + Pi Atelier installation.
Keep your current providers, logins, and model selection unchanged.

From the cloned repository directory, in a shell or Windows PowerShell:

```sh
npm ci
npm run check
pi install .
pi
```

Restart Pi, open `/atelier`, and enable **Subscription** in **Settings → Display**.
The panel starts hidden and can be hidden or reordered there.

Load only **one** copy: do not combine the upstream package, this package, and a
manually copied entry point. They share the preserved `subscription:limits` panel
id. Review `pi list` / `pi config` before enabling a duplicate.

This is an unpublished development package (`0.1.0`), marked private.
The final npm name and repository URL are not confirmed; no npm or GitHub install
source is advertised for this project yet.

## Data sources and limitations

The baseline reads existing OAuth sessions and queries these **undocumented**
usage interfaces; they are not guaranteed public APIs:

- Codex: `https://chatgpt.com/backend-api/wham/usage`.
- Native Anthropic: `https://api.anthropic.com/api/oauth/usage`.

It also consumes recognized quota headers from ordinary provider responses.
It does not generate inference requests to measure quota or manage authentication.
API-key credentials are not used for subscription requests. The separate `openai`
ChatGPT login is not a substitute for `openai-codex`.

Requests reject redirects and use a 10-second timeout. Quota state stays in memory;
credentials and account identifiers are not displayed or persisted in panel state.
For refresh intervals, retry behavior, known gaps, and validation limitations, see
[the development guide](docs/DEVELOPMENT.md#baseline-limitations-and-audit-findings).

## Development

[DEVELOPMENT.md](docs/DEVELOPMENT.md) covers local commands, architecture boundaries,
and manual smoke checks. See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.

## Acknowledgements / Origins

This distribution is based on
[pi-subscription-limits](https://github.com/alexmarco/pi-subscription-limits),
originally developed by [Alexmarco](https://github.com/alexmarco), and is used with
the author's explicit permission, as reported by this project's owner.
The original implementation, tests, and [upstream changelog](docs/UPSTREAM_CHANGELOG.md)
retain their attribution.

Underlying permission evidence and npm redistribution/relicensing scope still need
to be verified before publication. No new license grant is asserted.
See [PROVENANCE.md](docs/PROVENANCE.md) for the record and distribution blockers.
