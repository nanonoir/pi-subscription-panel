const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { loadRuntime, START } = require("./helpers/runtime-loader.cjs");

// Synthetic only: a fake `spawn` stands in for the CLI; no credential, network,
// disk write or Pi session. Antigravity retention rests on the owner-approved
// single-account-per-process assumption, not a verified identity.
const MIN = 60_000;
const tick = () => new Promise((done) => setImmediate(done));
const text = (entry) => JSON.stringify(entry.panel);
const panel = (env) =>
  text(
    env.registrations
      .filter((p) => p.panel.id === "subscription:antigravity")
      .at(-1),
  );
const usage = (fraction) =>
  JSON.stringify({
    command: {
      name: "usage",
      data: {
        groups: [
          {
            id: "g",
            buckets: [{ window: "weekly", remaining_fraction: fraction }],
          },
        ],
      },
    },
  });

function fakeSpawn() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
    child.pid = 4242;
    child.kill = () => {
      setImmediate(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}
const finish = (child, fraction) => {
  child.stdout.emit("data", Buffer.from(usage(fraction)));
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
};

function world(overrides = {}) {
  return {
    now: START,
    sandbox: undefined,
    agentDir: "synthetic-agent-dir",
    mode: "auto",
    spawner: fakeSpawn(),
    ...overrides,
  };
}

function boot(w) {
  const loaded = loadRuntime({
    expose: "",
    agentDir: w.agentDir,
    sandbox: w.sandbox,
    spawn: w.spawner.spawn,
    fetch: async () => new Response("", { status: 500 }),
    lstat: async () => ({ isFile: () => true, size: 100, mode: 0o100600 }),
    readFile: async (target) => {
      if (String(target).endsWith("subscription-panel.json"))
        return JSON.stringify({
          schemaVersion: 1,
          expandedProviders: ["antigravity"],
          refresh: { antigravity: { mode: w.mode } },
        });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  w.sandbox = loaded.sandbox;
  loaded.env.now = w.now;
  const handlers = {};
  loaded.entry.default({
    on: (event, handler) => (handlers[event] = handler),
    registerCommand() {},
  });
  const ctx = {
    mode: "tui",
    model: { provider: "openai" },
    ui: { notify() {} },
    modelRegistry: { getProviderAuth: async () => undefined },
  };
  const h = { ...loaded, handlers, ctx };
  h.start = async () => {
    await handlers.session_start({}, ctx);
    await tick();
  };
  h.advance = async (ms) => {
    w.now += ms;
    h.env.now = w.now;
    h.env.intervals.at(-1).fn();
    await tick();
  };
  return h;
}

async function reload(w, h, ms = 0) {
  await h.handlers.session_shutdown();
  w.now += ms;
  const next = boot(w);
  await next.start();
  return next;
}

/** A first load whose single CLI read has completed with 50% left. */
async function readOnce(w) {
  const first = boot(w);
  await first.start();
  assert.equal(w.spawner.children.length, 1);
  finish(w.spawner.children[0], 0.5);
  await tick();
  await tick();
  assert.match(panel(first.env), /50% left/);
  return first;
}

test("a reload within the gap restores the last Antigravity quota with no CLI call", async () => {
  const w = world();
  const first = await readOnce(w);
  const second = await reload(w, first, 2 * MIN);
  assert.notEqual(second.entry, first.entry);
  assert.match(panel(second.env), /50% left/);
  assert.equal(w.spawner.children.length, 1);
  // The scheduler's gap is untouched: still no read inside it.
  await second.advance(MIN);
  assert.equal(w.spawner.children.length, 1);
  assert.match(panel(second.env), /50% left/);
});

test("an eligible read after reload replaces the restored values", async () => {
  const w = world();
  const first = await readOnce(w);
  await first.handlers.session_shutdown();
  w.now += 21 * MIN;
  const second = boot(w);
  await second.start();
  assert.match(panel(second.env), /50% left/);
  assert.equal(w.spawner.children.length, 2);
  finish(w.spawner.children[1], 0.3);
  await tick();
  await tick();
  assert.match(panel(second.env), /30% left/);
  assert.doesNotMatch(panel(second.env), /50% left/);
});

test("disabled Antigravity is not restored and its memory is discarded", async () => {
  const w = world();
  const first = await readOnce(w);
  w.mode = "off";
  const off = await reload(w, first, MIN);
  assert.doesNotMatch(panel(off.env), /50% left/);
  // Opting back in later does not bring the old reading back.
  w.mode = "auto";
  const again = await reload(w, off, MIN);
  assert.doesNotMatch(panel(again.env), /50% left/);
  assert.equal(w.spawner.children.length, 1);
});

test("quota is retained per agent-directory scope", async () => {
  const w = world();
  const first = await readOnce(w);
  w.agentDir = "another-agent-dir";
  const other = await reload(w, first, MIN);
  assert.doesNotMatch(panel(other.env), /50% left/);
});

test("a retired controller's late CLI result is neither shown nor restored", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  await first.handlers.session_shutdown();
  finish(w.spawner.children[0], 0.5);
  await tick();
  await tick();
  w.now += MIN;
  const second = boot(w);
  await second.start();
  assert.doesNotMatch(panel(second.env), /50% left/);
});

test("disabling Antigravity at runtime forgets retained quota", async () => {
  const { createRefreshRuntime } = loadRuntime({
    entry: "refresh-runtime",
  }).entry;
  const { defaultPreferences } = loadRuntime({ entry: "preferences" }).entry;
  const store = loadRuntime({ entry: "quota-memory" }).entry.getQuotaMemory();
  const marker = store.digest("antigravity", "single-account-per-process");
  const prefs = defaultPreferences();
  prefs.refresh.antigravity.mode = "auto";
  const clock = { t: START };
  const delivered = [];
  const reads = [];
  const make = () =>
    createRefreshRuntime({
      scope: "s",
      owner: "o",
      preferences: () => prefs,
      readers: {
        codex: () => new Promise(() => undefined),
        anthropic: () => new Promise(() => undefined),
      },
      antigravity: {
        poll: () => new Promise((done) => reads.push(done)),
      },
      deliver: (r) => delivered.push(r),
      now: () => clock.t,
      random: () => 0,
      host: sharedHost,
      memory: {
        store,
        context: { antigravity: async () => marker },
      },
    });
  const sharedHost = {};
  const first = make();
  first.start();
  first.tick();
  reads[0]({
    result: {
      providerId: "antigravity",
      availability: "ready",
      pools: [
        {
          id: "g",
          windows: [
            {
              kind: "1w",
              remainingPercent: 50,
              observedAt: new Date(START).toISOString(),
              source: "official-cli",
            },
          ],
        },
      ],
    },
    meta: { authContext: marker },
    settled: Promise.resolve(),
  });
  await tick();
  await tick();
  assert.equal(store.recall("s", "antigravity", marker, START + 1)?.length, 1);

  prefs.refresh.antigravity.mode = "off";
  first.preferencesChanged();
  assert.equal(store.recall("s", "antigravity", marker, START + 1), undefined);
});

test("disable then re-enable while a read is in flight drops the old result", async () => {
  const { createRefreshRuntime } = loadRuntime({
    entry: "refresh-runtime",
  }).entry;
  const { defaultPreferences } = loadRuntime({ entry: "preferences" }).entry;
  const store = loadRuntime({ entry: "quota-memory" }).entry.getQuotaMemory();
  const marker = store.digest("antigravity", "single-account-per-process");
  const prefs = defaultPreferences();
  prefs.refresh.antigravity.mode = "auto";
  const clock = { t: START };
  const delivered = [];
  const reads = [];
  const runtime = createRefreshRuntime({
    scope: "s",
    owner: "o",
    preferences: () => prefs,
    readers: {
      codex: () => new Promise(() => undefined),
      anthropic: () => new Promise(() => undefined),
    },
    antigravity: { poll: () => new Promise((done) => reads.push(done)) },
    deliver: (r) => delivered.push(r),
    now: () => clock.t,
    random: () => 0,
    host: {},
    memory: { store, context: { antigravity: async () => marker } },
  });
  runtime.start();
  runtime.tick();
  assert.equal(reads.length, 1);

  prefs.refresh.antigravity.mode = "off";
  runtime.preferencesChanged();
  prefs.refresh.antigravity.mode = "auto";
  runtime.preferencesChanged();

  const before = delivered.length;
  reads[0]({
    result: {
      providerId: "antigravity",
      availability: "ready",
      pools: [
        {
          id: "g",
          windows: [
            {
              kind: "1w",
              remainingPercent: 50,
              observedAt: new Date(START).toISOString(),
              source: "official-cli",
            },
          ],
        },
      ],
    },
    meta: { authContext: marker },
    settled: Promise.resolve(),
  });
  await tick();
  await tick();
  assert.equal(
    delivered
      .slice(before)
      .some((r) => r.providerId === "antigravity" && r.pools.length > 0),
    false,
  );
  assert.equal(store.recall("s", "antigravity", marker, START + 1), undefined);

  // The gap from the cancelled attempt still holds: no new read inside it.
  clock.t += MIN;
  runtime.tick();
  assert.equal(reads.length, 1);
});
