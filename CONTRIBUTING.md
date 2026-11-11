# Contributing

Pi Subscription Panel is being implemented phase by phase against [the PRD](docs/PRD.md).
Keep changes within the assigned phase; do not add provider discovery or integrations
during repository setup.

## Local workflow

1. Use Node.js 22 or newer and run `npm ci`.
2. Follow [the development guide](docs/DEVELOPMENT.md).
3. Run `npm run check` before proposing a change. Use focused tests while iterating;
   no browser/E2E infrastructure is required for the current baseline.

Preserve existing authentication, model execution, and Atelier compatibility.
Never commit credentials, tokens, personal usage data, logs, or generated artifacts.
Use synthetic fixtures in tests and keep documentation honest about planned features.

## Review and delivery

Use Conventional Commits, for example `docs: clarify local installation` or
`fix: correct quota parsing`. Keep changes focused and explain validation and limitations.
No branch protection, Gitflow policy, or release infrastructure is assumed for this
new repository. CI checks formatting, lint, types, tests, and PR-title conventions.

Commits, push, pull requests, merges, and publication require the owner's applicable
authorization. Phase 1 ends with a reviewable first-commit candidate, not a commit.
Release and publish workflows are intentionally absent until npm publication is
explicitly requested; see the [distribution status](docs/PROVENANCE.md).
