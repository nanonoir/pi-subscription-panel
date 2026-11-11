# npm 1.0.0 publication

## Objective and authorization

The owner approved executing the npm preparation/publication plan: deliver the
showcase README and GIF, restrict package contents, remove the publication guard,
validate, publish 1.0.0, and verify installation compatibility. Git delivery for
these changes is included in that approved plan. Keep existing v1.0.0 Git tag
unchanged; npm preparation is a subsequent commit with the same runtime.

## Scope and decisions

- Publish unscoped `pi-subscription-panel` 1.0.0 to the public npm registry.
- Include `extensions/`, the showcase GIF, README, LICENSE, and CHANGELOG only.
  Runtime dependencies remain declared; exclude tests, internal documentation,
  tooling, and local configuration from the tarball.
- Do not access token files or credentials. Use npm's existing authentication;
  browser login/2FA requires owner participation when necessary.
- No model inference or real quota reads are part of validation.

## Execution

- [x] Inspect working tree and registry authentication. `npm whoami` returned 401;
      publication requires a valid owner session.
- [x] Update manifest, lock metadata and user-facing installation instructions.
- [x] Validate package contents, checks and publication dry run.
- [ ] Deliver changes by reviewed PR with CI to main.
- [ ] Publish after authentication is available; verify registry and Pi package
      compatibility without changing the owner's installed Pi configuration.
- [ ] Record result and any remaining work; archive this plan.

## Validation and outcome

`npm run check` passed: 254 tests, typecheck, lint and formatting. Independent
package review passed. `npm pack --dry-run` contains 20 allowlisted files, including
the runtime, README, MIT license and showcase GIF; tests and internal configuration
are excluded. `npm publish --dry-run --access public` succeeded without writing to
the registry. Lockfile regeneration changed peer metadata only, not resolved
dependency versions, URLs or integrity hashes. Real authentication remains blocked
by the observed `npm whoami` 401.
