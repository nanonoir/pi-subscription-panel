const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function load(name, mocks = {}) {
  const cache = {};
  function localLoad(moduleName) {
    if (cache[moduleName]) return cache[moduleName];
    const source = fs.readFileSync(
      path.join(__dirname, `../extensions/${moduleName}.ts`),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const exports = {};
    cache[moduleName] = exports;
    vm.runInThisContext(`(function(exports,require){${compiled}
})`)(exports, (id) =>
      id.startsWith("./") && id.endsWith(".ts")
        ? localLoad(id.slice(2, -3))
        : (mocks[id] ?? require(id)),
    );
    return exports;
  }
  return localLoad(name);
}

const prefs = load("preferences", {
  "@earendil-works/pi-coding-agent": {
    getAgentDir: () => {
      throw new Error("Real agent dir must not be used");
    },
  },
});
const { loadPreferences, savePreferences, normalizePreferences, WARNING } =
  prefs;
const plain = (value) => JSON.parse(JSON.stringify(value));

async function withDir(run) {
  const root = path.join(process.env.TEMP || os.tmpdir(), "opencode");
  await fsp.mkdir(root, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(root, "prefs-test-"));
  try {
    await run(dir, path.join(dir, "nested", "subscription-panel.json"));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("missing file yields writable defaults without creating anything", () =>
  withDir(async (dir, file) => {
    const result = await loadPreferences({ path: file });
    assert.equal(result.readOnly, false);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(plain(result.preferences), {
      displayMode: "remaining",
      expandedProviders: ["codex", "claude-code", "antigravity", "anthropic"],
      refresh: {
        codexSeconds: 60,
        claude: { mode: "response-event" },
        antigravity: { mode: "off", activeSeconds: 180, idleSeconds: 1200 },
        whileCollapsed: true,
      },
      staleAfterSeconds: 180,
    });
    assert.deepEqual(await fsp.readdir(dir), []);
  }));

test("default path uses the public agent directory API", async () => {
  const seen = [];
  const mod = load("preferences", {
    "@earendil-works/pi-coding-agent": { getAgentDir: () => "/agent" },
    "node:fs/promises": {
      ...fsp,
      readFile: async (file) => {
        seen.push(file);
        return "{}";
      },
    },
  });
  await mod.loadPreferences();
  assert.equal(seen[0], path.join("/agent", "subscription-panel.json"));
});

test("partial and invalid settings fall back field by field", () => {
  const result = normalizePreferences({
    displayMode: "used",
    expandedProviders: ["anthropic", "bogus", "codex", "codex", 7],
    refresh: {
      codexSeconds: 0,
      claude: { mode: "poll", seconds: 1 },
      antigravity: { mode: "auto", activeSeconds: -5, idleSeconds: "x" },
    },
    staleAfterSeconds: 30,
    extra: "dropped",
  });
  assert.equal(result.displayMode, "used");
  assert.deepEqual(plain(result.expandedProviders), ["codex", "anthropic"]);
  assert.equal(result.refresh.codexSeconds, 60);
  assert.deepEqual(plain(result.refresh.claude), { mode: "response-event" });
  assert.deepEqual(plain(result.refresh.antigravity), {
    mode: "auto",
    activeSeconds: 180,
    idleSeconds: 1200,
  });
  assert.equal(result.staleAfterSeconds, 60);
  assert.equal("extra" in result, false);
});

test("intervals: below minimum clamp, non-integer/unsafe/NaN use defaults", () => {
  const read = (value) =>
    normalizePreferences({ refresh: { codexSeconds: value } }).refresh
      .codexSeconds;
  assert.equal(read(-10), 60);
  assert.equal(read(59), 60);
  assert.equal(read(300), 300);
  for (const bad of [NaN, Infinity, 90.5, 2 ** 60, "120", null]) {
    assert.equal(read(bad), 60);
  }
});

test("Claude mode is always response-event, even when auto-like input is stored", () => {
  for (const mode of ["auto", "poll", "interval", undefined]) {
    const result = normalizePreferences({ refresh: { claude: { mode } } });
    assert.deepEqual(plain(result.refresh.claude), { mode: "response-event" });
  }
});

test("refresh while collapsed defaults on, accepts only booleans and is independent of expansion", () => {
  const read = (value) =>
    normalizePreferences({
      expandedProviders: [],
      refresh: { whileCollapsed: value },
    });
  assert.equal(read(false).refresh.whileCollapsed, false);
  assert.equal(read(true).refresh.whileCollapsed, true);
  for (const bad of ["false", 0, null, undefined])
    assert.equal(read(bad).refresh.whileCollapsed, true);
  assert.deepEqual(plain(read(false).expandedProviders), []);
});

test("expandedProviders: [] means all collapsed; non-array uses defaults", () => {
  assert.deepEqual(
    normalizePreferences({ expandedProviders: [] }).expandedProviders,
    [],
  );
  assert.equal(
    normalizePreferences({ expandedProviders: "codex" }).expandedProviders
      .length,
    4,
  );
});

test("legacy file without schemaVersion loads; save writes current version", () =>
  withDir(async (_dir, file) => {
    await fsp.mkdir(path.dirname(file));
    await fsp.writeFile(file, JSON.stringify({ displayMode: "used" }));
    const loaded = await loadPreferences({ path: file });
    assert.equal(loaded.preferences.displayMode, "used");
    assert.equal(loaded.readOnly, false);
    assert.equal(
      JSON.parse(await fsp.readFile(file, "utf8")).schemaVersion,
      undefined,
    );

    const saved = await savePreferences(loaded.preferences, { path: file });
    assert.equal(saved.saved, true);
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).schemaVersion, 1);
  }));

test("save creates the directory, round-trips and leaves no temp files", () =>
  withDir(async (_dir, file) => {
    const input = normalizePreferences({
      displayMode: "used",
      expandedProviders: ["claude-code"],
      refresh: { codexSeconds: 120, antigravity: { mode: "auto" } },
    });
    assert.deepEqual(await savePreferences(input, { path: file }), {
      saved: true,
      warnings: [],
    });
    const reloaded = await loadPreferences({ path: file });
    assert.deepEqual(plain(reloaded.preferences), plain(input));
    assert.deepEqual(await fsp.readdir(path.dirname(file)), [
      "subscription-panel.json",
    ]);
    // Overwriting an existing valid file also works.
    input.displayMode = "remaining";
    assert.equal((await savePreferences(input, { path: file })).saved, true);
    assert.equal(
      (await loadPreferences({ path: file })).preferences.displayMode,
      "remaining",
    );
  }));

test("malformed or future-schema files are read-only and byte-identical after save", () =>
  withDir(async (_dir, file) => {
    await fsp.mkdir(path.dirname(file));
    const cases = [
      ["{not json", WARNING.MALFORMED],
      ["[]", WARNING.MALFORMED],
      ['{"schemaVersion":"1"}', WARNING.MALFORMED],
      ['{"schemaVersion":0}', WARNING.MALFORMED],
      ['{"schemaVersion":2,"secretish":"SECRET"}', WARNING.FUTURE_SCHEMA],
    ];
    for (const [content, code] of cases) {
      await fsp.writeFile(file, content);
      const loaded = await loadPreferences({ path: file });
      assert.equal(loaded.readOnly, true);
      assert.equal(loaded.preferences.displayMode, "remaining");
      assert.equal(loaded.warnings[0].code, code);
      const text = JSON.stringify(loaded.warnings);
      assert.equal(text.includes("SECRET"), false);
      assert.equal(text.includes(file), false);

      const result = await savePreferences(loaded.preferences, { path: file });
      assert.equal(result.saved, false);
      assert.equal(await fsp.readFile(file, "utf8"), content);
      assert.deepEqual(await fsp.readdir(path.dirname(file)), [
        "subscription-panel.json",
      ]);
    }
  }));

test("a failed rename reports a generic warning and removes the temp file", () =>
  withDir(async (_dir, file) => {
    const mod = load("preferences", {
      "@earendil-works/pi-coding-agent": { getAgentDir: () => "/unused" },
      "node:fs/promises": {
        ...fsp,
        rename: async () => {
          throw new Error(`boom ${file}`);
        },
      },
    });
    const result = await mod.savePreferences(mod.defaultPreferences(), {
      path: file,
    });
    assert.equal(result.saved, false);
    assert.equal(result.warnings[0].code, "write-failed");
    assert.equal(JSON.stringify(result).includes("boom"), false);
    assert.deepEqual(await fsp.readdir(path.dirname(file)), []);
  }));
