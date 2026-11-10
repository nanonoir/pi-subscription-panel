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
 * `readFile` (fs/promises override; defaults to ENOENT).
 */
function loadRuntime(options = {}) {
  const env = {
    now: START,
    registrations: [],
    intervals: [],
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
      readStoredCredential: () => options.credential,
      getAgentDir: () => "synthetic-agent-dir",
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
    "node:fs/promises": {
      readFile: options.readFile ?? missing,
      mkdir: record("mkdir"),
      writeFile: record("write"),
      rename: record("rename"),
      rm: record("rm"),
    },
  };
  const sandbox = {
    Buffer,
    AbortSignal,
    DOMException,
    structuredClone,
    Date: FakeDate,
    fetch: (...args) => {
      env.requests.push(args[0]);
      if (!options.fetch) throw new Error("Unexpected request");
      return options.fetch(...args);
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
  return { env, entry: loadModule(options.entry ?? "index", options.expose) };
}

module.exports = { loadRuntime, START };
