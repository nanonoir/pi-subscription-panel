# Pi Subscription Panel

Read-only subscription usage panel for Pi and Pi Atelier. Models keep the canonical `openai/{model}` integration. The owner additionally signed into Pi's OpenAI Codex provider for quota reads only: one authorized WHAM probe returned 200 with real five-hour/weekly percentages and resets. Use that existing `openai-codex` OAuth only for quota, never switch execution/authentication or install another CLI. Runtime wiring includes safe scheduling and opt-in Antigravity acquisition; the owner confirmed production functionality and release readiness.

## Stack and structure

- Node.js 22+ and npm; TypeScript 5.9, strict NodeNext modules. Pi loads the extension directly, without a build step.
- Pi Atelier `^0.16.0` supplies the sidebar contribution API; Pi coding-agent and TUI are peer dependencies. The local Atelier declaration is a type-checking shim, not runtime code.
- `extensions/index.ts` contains the runtime; `test/usage.test.cjs` uses Node's test runner and mocks. ESLint, Prettier, and TypeScript provide quality checks. Manifests and configuration are authoritative for dependency versions.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for runtime boundaries and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed commands, smoke checks, and limitations.

## Working here

- `npm ci` installs the locked dependencies. Use `npm run typecheck`, `npm run lint`, `npm test`, and `npm run format:check` for focused checks; `npm run check` runs all four. CI uses Node 22 and `npm run check`.
- Preserve existing provider authentication, model routing, and panel identifiers; do not send inference requests to measure quota or load duplicate panel copies.
- [Product spec index](docs/product-specs/index.md) identifies the canonical PRD and its draft target; distinguish planned features from current behavior. [Design index](docs/design-docs/index.md) catalogs durable decisions. [ExecPlan guidance](docs/PLANS.md) and [technical debt](docs/exec-plans/tech-debt-tracker.md) track execution context.
- [Provenance](docs/PROVENANCE.md) records attribution, MIT licensing basis, and distribution status. Version 1.0.0 is MIT; the package stays `private` until npm publication is explicitly requested, and Git/npm actions still need the owner's execution request. See [CONTRIBUTING.md](CONTRIBUTING.md).
