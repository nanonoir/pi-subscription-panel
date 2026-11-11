const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const ts = require("typescript");

function load(name, mocks = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, `../../extensions/${name}.ts`),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${compiled}\n})`)(
    exports,
    (id) => mocks[id] ?? require(id),
  );
  return exports;
}

// Real contracts, preferences, adapters and actions. Only the host package is
// stubbed, so the real file I/O functions are never reached (save and load are
// injected by each test).
const contracts = load("quota-contracts");
const adapters = load("provider-adapters", {
  "./quota-contracts.ts": contracts,
});
const preferences = load("preferences", {
  "@earendil-works/pi-coding-agent": { getAgentDir: () => "unused" },
  "./quota-contracts.ts": contracts,
});
const outcomes = load("poll-outcome", { "./quota-contracts.ts": contracts });
const actions = load("subscription-actions", {
  "./poll-outcome.ts": outcomes,
  "./preferences.ts": preferences,
  "./quota-contracts.ts": contracts,
});

const notices = [];

module.exports = {
  load,
  contracts,
  adapters,
  preferences,
  actions,
  notices,
  ALL: ["codex", "claude-code", "antigravity", "anthropic"],
  defaults: () => preferences.defaultPreferences(),
  tick: () => new Promise((done) => setImmediate(done)),
  deferred() {
    const box = {};
    box.promise = new Promise((resolve) => (box.resolve = resolve));
    return box;
  },
  tui: (extra = {}) => ({
    mode: "tui",
    ui: { notify: (message) => notices.push(message), ...extra },
  }),
};
