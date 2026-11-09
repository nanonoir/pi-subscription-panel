# Phase 1 — Repository foundation

## Scope and constraints

Execute only Phase 1 of the PRD supplied as `docs/pi-subscription-panel.md`
(canonical destination: `docs/PRD.md`). Preserve extension runtime, authentication,
model execution, dependency ranges, and Atelier panel identifiers. No commit,
push, publication, provider discovery, E2E, or later-phase implementation.

## Plan

- [x] Read the full supplied PRD; audit source, tests, configuration, automation,
      attribution, and Git state.
- [x] Establish baseline with `npm ci` and inexpensive existing checks.
- [x] Align local package identity and documentation; protect against accidental
      publication; preserve upstream notices and record permission limitations.
- [x] Create canonical PRD, development guide, and future configuration decision
      without implementing settings or restructuring runtime modules.
- [x] Run relevant checks, review the initial-commit candidate, and obtain an
      independent review.
- [x] Reconcile findings, close this plan, and propose a commit without creating it.

## Confirmed findings and decisions

- Repository is on `main` with no commits, no remote, and all project files untracked.
- `docs/PRD.md` does not exist initially; the complete supplied PRD is the source.
- Runtime is a single TypeScript extension plus an ambient Atelier declaration;
  ten Node unit tests use mocked credentials, HTTP, and Atelier registration.
- Current support is Codex and native Pi Anthropic OAuth, not Claude Code CLI or
  Antigravity. README currently overstates support and npm availability.
- Use `pi-subscription-panel` as the local working identity, not as a claim of npm
  ownership. Keep the package private pending owner approval for distribution.
- No new repository URL is known; omit inherited ownership URLs rather than inventing them.
- Keep version 1.0.2 as inherited baseline metadata, not a new published release.
- Preserve upstream changelog as historical material. No license declaration will
  be added without verified permission scope.
- Release automation from upstream must not create releases or publish this copy.

## Implementation Outcome

### Implemented

Established the private local `pi-subscription-panel` identity with inherited version
1.0.2 and removed obsolete repository ownership URLs. Updated the README, canonical PRD
and original-path link, development and provenance guidance, and contributing guidance.
Removed release and publication workflows, retained CI without the inherited Gitflow
title rule, and normalized ignore rules and line endings. No authentication, model logic,
dependency ranges, or later-phase functionality changed.

### Deviations from Design

None. The repository URL and final distribution identity remain undecided; no values
were invented. The reserved future configuration is documented but not implemented.

### Validation

`npm ci` succeeded twice with Node 24.18.0 and npm 11.16.0. The final `npm run check`
passed formatting, lint, type checking, and all ten fast unit tests. `npm ls --depth=0`
validated Atelier 0.16.0 and Pi peers 1.3.0. Syntax trees for source, tests, and the
ambient declaration matched the pre-format snapshot. Package and lock identities,
private status, and entrypoint were checked; representative secret and generated paths
were ignored, and `npm pack --dry-run` included the entrypoint without those paths.
A staged heuristic secret scan found no hits; `git diff --check` and its cached variant
passed after removing Markdown trailing spaces. Independent review passed with the sole
finding that this plan needed closure.

### Follow-up

The authenticated Pi/Atelier TUI smoke test was not run; manual steps are in
`docs/DEVELOPMENT.md`. Inherited dependency audit findings and distribution blockers,
including permission evidence, npm name and scope, license, and repository URL, remain
recorded in `docs/DEVELOPMENT.md` and `docs/PROVENANCE.md`. No commit, push, publication,
or global Pi changes were made. Proposed initial commit message, subject to user
approval: `chore: initialize subscription panel from authorized upstream source`.
