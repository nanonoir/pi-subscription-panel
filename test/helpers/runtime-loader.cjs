const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const EXTENSIONS = path.join(__dirname, "../../extensions");
const START = Date.parse("2026-01-01T12:00:00Z");

/**
 * Loads the real extension module graph in a fresh context. Only the host
 * packages, fetch, timers, the clock and fs/promises are replaced, so no real
 * credential, network or preference file can be touched.
 *
 * Options: `entry` (module name, default "index"), `expose` (extra exports to
 * attach to the entry), `credential` (stored credential), `fetch`, and
 * `readFile`/`lstat` (fs/promises overrides; default to ENOENT), and `spawn`
 * (child_process override; defaults to throwing), `agentDir` (mutable agent
 * directory) and `sandbox` (an earlier load's `sandbox`, for a real reload).
 */
function loadRuntime(options = {}) {
  const env = {
    now: START,
    registrations: [],
    intervals: [],
    timeouts: [],
    requests: [],
    fileCalls: [],
  };
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [env.now]));
    }
    static now() {
      return env.now;
    }
  }
  const missing = async () => {
    env.fileCalls.push("read");
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const record = (name) => async () => void env.fileCalls.push(name);
  const mocks = {
    "@earendil-works/pi-coding-agent": {
      // A function models a stored credential that changes while running.
      readStoredCredential: () =>
        typeof options.credential === "function"
          ? options.credential()
          : options.credential,
      getAgentDir: () => options.agentDir ?? "synthetic-agent-dir",
    },
    "pi-atelier/extensions/index.ts": {
      registerSidebarPanel(_pi, panel, registration) {
        const entry = { panel, registration, updates: 0, disposed: 0 };
        env.registrations.push(entry);
        return {
          update(value) {
            entry.panel = value;
            entry.updates++;
          },
          dispose() {
            entry.disposed++;
          },
        };
      },
    },
    // A real Antigravity CLI must never run; tests provide a fake `spawn`.
    "node:child_process": {
      spawn:
        options.spawn ??
        (() => {
          throw new Error("Unexpected spawn");
        }),
    },
    "node:fs/promises": {
      readFile: options.readFile ?? missing,
      lstat: options.lstat ?? missing,
      mkdir: record("mkdir"),
      writeFile: record("write"),
      rename: record("rename"),
      rm: record("rm"),
    },
  };
  const fresh = {
    Buffer,
    AbortController,
    AbortSignal,
    DOMException,
    structuredClone,
    Date: FakeDate,
    fetch: (...args) => {
      env.requests.push(args[0]);
      if (!options.fetch) throw new Error("Unexpected request");
      return options.fetch(...args);
    },
    // Deterministic: timeouts are recorded and only fire when a test says so.
    process: { env: {} },
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false };
      env.timeouts.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    setInterval(fn) {
      const timer = { fn, cleared: false, unref() {} };
      env.intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      timer.cleared = true;
    },
  };
  // `sandbox` reuses an earlier load's global, so its realm-wide registries
  // survive while every module is evaluated again: a real module reload.
  const sandbox = options.sandbox
    ? Object.assign(options.sandbox, fresh)
    : fresh;
  vm.createContext(sandbox);

  const cache = new Map();
  const requireFrom = (id) =>
    mocks[id] ??
    (id.startsWith("./") ? loadModule(id.slice(2, -3)) : require(id));
  function loadModule(name, expose) {
    if (cache.has(name) && !expose) return cache.get(name);
    const source = fs.readFileSync(path.join(EXTENSIONS, `${name}.ts`), "utf8");
    const { outputText } = ts.transpileModule(
      expose ? `${source}\nObject.assign(exports, { ${expose} });` : source,
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    );
    const exports = {};
    cache.set(name, exports);
    vm.runInContext(`(function(exports,require){${outputText}\n})`, sandbox)(
      exports,
      requireFrom,
    );
    return exports;
  }
  return {
    env,
    sandbox,
    entry: loadModule(options.entry ?? "index", options.expose),
  };
}

module.exports = { loadRuntime, START };
