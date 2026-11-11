# Dependency update: Atelier 0.18, TypeScript 6.0

## Objective and authorization

Integrate the existing Dependabot PR #1 branch
(`dependabot/npm_and_yarn/npm-dependencies-09577f18be`) without a major-version
surprise. The owner authorized push, PR update and merge to `main` after CI; the
primary session performs those Git actions. No force, rebase or history rewrite.

## Scope and decisions

- Keep from the PR: `pi-atelier ^0.18.0`, `eslint ^10.14.0`, `globals ^17.14.0`.
- Replace `typescript ^7.0.2` with `~6.0.3`: `typescript-eslint` 8.72.x declares
  peer `typescript >=4.8.4 <6.1.0`, so TypeScript 7 is unsupported. Raise
  `typescript-eslint` to `^8.72.2`.
- Restrict the npm group to `minor` and `patch` updates so majors fall outside
  the group and arrive as individual Dependabot PRs.
- TypeScript 6 deprecates `baseUrl`; remove it from `tsconfig.json` and make the
  Atelier shim path explicit (`./types/pi-atelier.d.ts`).
- Verify the `pi-atelier` 0.18 `registerSidebarPanel` API and the local type shim
  against the installed package; change code only if necessary.
- Out of scope: quota calls, authentication, global Pi configuration, npm
  publication and the active npm publication plan.

## Execution

- [x] Fetch and switch to the existing Dependabot branch safely.
- [x] Adjust manifest and regenerate lockfile with a normal `npm install`.
- [x] Inspect Atelier 0.18 exports and shim compatibility.
- [x] Update Dependabot config and stack docs.
- [x] Focused validation, then `npm run check`.

## Decisions

- Dependabot's `ignore` would suppress majors entirely. Group-level
  `update-types: [minor, patch]` keeps majors out of the group so they arrive as
  individual PRs; this is the chosen form.

## Validation and outcome

- Resolved: pi-atelier 0.18.0 (peers `pi-coding-agent`/`pi-tui` `>=0.84.0`),
  typescript 6.0.3, typescript-eslint 8.72.2 (peer `typescript >=4.8.4 <6.1.0`),
  eslint 10.14.0 (peer `^10.0.0`), globals 17.14.0.
- Atelier 0.18 `registerSidebarPanel(pi, panel, {source})` returning
  `{update, dispose}` and the contribution shape (id, title, rows, keyValues with
  progress, role) match `types/pi-atelier.d.ts`; `labeledRow` (label column 12)
  still matches the copy in `test/narrow-render.test.cjs`. No runtime change.
- `tsc` initially failed with TS5101 (`baseUrl`); fixed in `tsconfig.json`.
  Shim resolution confirmed via `--traceResolution`.
- `npm run check` passed, including 254 tests; independent review passed.

## Implementation Outcome

### Implemented

Updated the dependency manifest and lockfile, TypeScript configuration,
Dependabot grouping, and stack documentation as described above. The existing
Atelier shim remains compatible with the inspected 0.18 API; runtime code was
unchanged.

### Deviations from Design

The incoming PR's TypeScript 7 was replaced with `~6.0.3` because the selected
typescript-eslint 8.72.2 does not support TypeScript 7. TypeScript 6 also required
removing deprecated `baseUrl` and explicitly prefixing the shim path.

### Validation

The full `npm run check` passed with 254 tests, and independent review passed.
The Atelier API and shim were inspected, and TypeScript shim resolution was
verified. These checks do not establish live TUI compatibility.

The dependency audit reported 12 existing vulnerabilities; the locked `undici`
and `minimatch` findings were unchanged from `main` and were not fixed by this
work. A passing check is not a clean audit.

### Follow-up

Delivery remains pending: the primary session will push the existing branch and
update and merge PR #1 after CI. npm publication was excluded and has not been
performed. Existing dependency audit findings remain tracked in the development
guide and technical debt tracker.
