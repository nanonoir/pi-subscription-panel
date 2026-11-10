const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
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
    vm.runInThisContext(`(function(exports,require,setTimeout,clearTimeout){${compiled}
})`)(
      exports,
      (id) =>
        id.startsWith("./") && id.endsWith(".ts")
          ? localLoad(id.slice(2, -3))
          : (mocks.modules?.[id] ?? require(id)),
      mocks.setTimeout ?? setTimeout,
      mocks.clearTimeout ?? clearTimeout,
    );
    return exports;
  }
  return localLoad(name);
}
const { createAntigravityAdapter } = load("antigravity-cli");
const { AVAILABILITY } = load("quota-contracts");
const timestamp = 1700000000000;
const iso = new Date(timestamp).toISOString();
const group = (name, buckets) => ({ name, buckets });
const bucket = (window, remaining_fraction, reset_time) => ({
  window,
  remaining_fraction,
  reset_time,
});
const payload = (...groups) => ({
  status: "SUCCESS",
  command: { name: "usage", data: { groups } },
});

test("CLI is opt-in, bounded, inherits environment, and sanitizes errors", async () => {
  const calls = [];
  const runner = async (...args) => {
    calls.push(args);
    return JSON.stringify(payload(group("A", [bucket("5h", 0.5)])));
  };
  assert.equal(
    (await createAntigravityAdapter({ runner }).refresh()).availability,
    AVAILABILITY.WAITING,
  );
  assert.equal(calls.length, 0);
  const prior = process.env.AGY_BIN;
  process.env.AGY_BIN = "synthetic-agy";
  try {
    const adapter = createAntigravityAdapter({
      enabled: true,
      runner,
      now: () => timestamp,
    });
    assert.equal((await adapter.refresh()).pools[0].windows[0].observedAt, iso);
    assert.equal(calls[0][0], "synthetic-agy");
    assert.deepEqual(calls[0][1], [
      "--print",
      "/usage",
      "--output-format",
      "json",
      "--print-timeout",
      "30s",
    ]);
    assert.deepEqual(calls[0][2], {
      timeout: 35000,
      maxBuffer: 1048576,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    delete process.env.AGY_BIN;
    await adapter.refresh();
    assert.equal(calls[1][0], "agy");
    const failure = await createAntigravityAdapter({
      enabled: true,
      runner: async () => {
        throw new Error("secret stdout stderr timeout");
      },
    }).refresh();
    assert.equal(failure.availability, AVAILABILITY.ERROR);
    assert.equal(JSON.stringify(failure).includes("secret"), false);
    const malformed = await createAntigravityAdapter({
      enabled: true,
      runner: async () =>
        JSON.stringify(payload(group("A", [bucket("5h", null)]))),
    }).refresh();
    assert.equal(malformed.availability, AVAILABILITY.UNAVAILABLE);
  } finally {
    if (prior === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = prior;
  }
});

function productionRunner() {
  const { EventEmitter } = require("node:events");
  const timers = [];
  const env = { children: [], spawnArgs: [], cleared: 0 };
  const spawn = (...args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.destroyed = 0;
    child.stdout.destroy = () => child.stdout.destroyed++;
    child.signals = [];
    child.kill = (signal) => child.signals.push(signal);
    env.spawnArgs.push(args);
    env.children.push(child);
    return child;
  };
  const adapter = load("antigravity-cli", {
    modules: { "node:child_process": { spawn } },
    setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimeout: () => env.cleared++,
  }).createAntigravityAdapter({ enabled: true, now: () => timestamp });
  env.adapter = adapter;
  env.refresh = () => adapter.refresh();
  env.timers = timers;
  return env;
}
const report = JSON.stringify(payload(group("A", [bucket("5h", 0.5)])));

test("production runner resolves on clean close and clears its watchdog", async () => {
  const env = productionRunner();
  const pending = env.refresh();
  const child = env.children[0];
  assert.equal(env.timers[0].ms, 35000);
  assert.equal("timeout" in env.spawnArgs[0][2], false);
  child.stdout.emit("data", Buffer.from(report));
  child.emit("close", 0, null);
  assert.equal((await pending).availability, AVAILABILITY.READY);
  assert.equal(env.cleared, 1);
  assert.deepEqual(child.signals, []);
  env.timers[0].fn();
  assert.deepEqual(child.signals, []);
});

test("production runner rejects generically on nonzero exit, signal and errors", async () => {
  for (const [emit, signals] of [
    [(c) => c.emit("close", 1, null), []],
    [(c) => c.emit("close", null, "SIGTERM"), []],
    [(c) => c.emit("error", new Error("secret path")), ["SIGKILL"]],
    [(c) => c.stdout.emit("error", new Error("secret stream")), ["SIGKILL"]],
  ]) {
    const env = productionRunner();
    const pending = env.refresh();
    const child = env.children[0];
    child.stdout.emit("data", Buffer.from("secret"));
    emit(child);
    const result = await pending;
    assert.equal(result.availability, AVAILABILITY.ERROR);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(env.cleared, 1);
    assert.equal(child.stdout.destroyed, 1);
    assert.deepEqual(child.signals, signals);
    child.emit("close", null, "SIGKILL");
    env.timers[0].fn();
    assert.deepEqual(child.signals, signals);
    assert.equal(child.stdout.destroyed, 1);
  }
});

test("production runner kills only the owned child with SIGKILL on overflow and ignores late events", async () => {
  const env = productionRunner();
  const pending = env.refresh();
  const child = env.children[0];
  child.stdout.emit("data", Buffer.alloc(1048577));
  assert.equal((await pending).availability, AVAILABILITY.ERROR);
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(child.stdout.destroyed, 1);
  child.stdout.emit("data", Buffer.alloc(1048577));
  child.emit("exit", null, "SIGKILL");
  child.emit("close", null, "SIGKILL");
  env.timers[0].fn();
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(child.stdout.destroyed, 1);
  assert.equal(env.cleared, 1);
});

test("production runner watchdog settles without close and does not re-kill an exited child", async () => {
  const env = productionRunner();
  const hung = env.refresh();
  env.children[0].emit("exit", 0, null);
  env.timers[0].fn();
  assert.equal((await hung).availability, AVAILABILITY.ERROR);
  assert.deepEqual(env.children[0].signals, []);
  assert.equal(env.children[0].stdout.destroyed, 1);
  const silent = productionRunner();
  const pending = silent.refresh();
  silent.timers[0].fn();
  assert.equal((await pending).availability, AVAILABILITY.ERROR);
  assert.deepEqual(silent.children[0].signals, ["SIGKILL"]);
  assert.equal(silent.children[0].stdout.destroyed, 1);
  silent.children[0].emit("close", 0, null);
  assert.equal(silent.cleared, 1);
});

function abortable() {
  const listeners = [];
  const signal = {
    aborted: false,
    addEventListener: (_t, fn) => listeners.push(fn),
    removeEventListener: (_t, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  signal.listeners = listeners;
  signal.abort = () => {
    signal.aborted = true;
    [...listeners].forEach((fn) => fn());
  };
  return signal;
}

test("poll reports indeterminate failures as manual-retry metadata without HTTP status", async () => {
  const bad = await createAntigravityAdapter({
    enabled: true,
    runner: async () => {
      throw new Error("HTTP 429 secret");
    },
  }).poll();
  assert.deepEqual(bad.meta, { requireManualRetry: true });
  assert.equal(bad.result.availability, AVAILABILITY.ERROR);
  await bad.settled;
  const odd = await createAntigravityAdapter({
    enabled: true,
    runner: async () => "{}",
    now: () => timestamp,
  }).poll();
  assert.deepEqual(odd.meta, { requireManualRetry: true });
  const ok = await createAntigravityAdapter({
    enabled: true,
    runner: async () => report,
    now: () => timestamp,
  }).poll();
  assert.deepEqual(ok.meta, {});
});

test("poll does not spawn when already aborted and ignores late results after abort", async () => {
  const signal = abortable();
  signal.aborted = true;
  let calls = 0;
  const adapter = createAntigravityAdapter({
    enabled: true,
    runner: async () => (calls++, report),
  });
  const pre = await adapter.poll({ signal });
  assert.equal(pre.meta.cancelled, true);
  assert.equal(calls, 0);
  const late = abortable();
  const out = await createAntigravityAdapter({
    enabled: true,
    runner: async () => (late.abort(), report),
  }).poll({ signal: late });
  assert.equal(out.meta.cancelled, true);
});

test("abort kills only the owned child, reports cancellation, and settles after exit", async () => {
  const env = productionRunner();
  const signal = abortable();
  const pending = env.adapter.poll({ signal });
  const child = env.children[0];
  child.stdout.emit("data", Buffer.from("secret"));
  signal.abort();
  const out = await pending;
  assert.equal(out.meta.cancelled, true);
  assert.equal(JSON.stringify(out).includes("secret"), false);
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(child.stdout.destroyed, 1);
  assert.equal(signal.listeners.length, 0);
  let settled = false;
  out.settled.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  child.emit("exit", null, "SIGKILL");
  await out.settled;
  child.emit("close", null, "SIGKILL");
  signal.abort();
  child.stdout.emit("data", Buffer.alloc(2000000));
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

const flush = () => new Promise((r) => setImmediate(r));

test("settlement is not granted by a timeout or grace timer while the child has not exited", async () => {
  const env = productionRunner();
  const signal = abortable();
  const pending = env.adapter.poll({ signal });
  signal.abort();
  const out = await pending;
  assert.equal(env.timers.length, 1);
  env.timers[0].fn();
  let settled = false;
  out.settled.then(() => (settled = true));
  await flush();
  assert.equal(settled, false);
  env.children[0].emit("close", null, "SIGKILL");
  await out.settled;
});

test("child error with a pid (failed kill) does not settle until exit/close", async () => {
  const env = productionRunner();
  const pending = env.refresh();
  const poll = env.adapter.poll();
  env.children[0].pid = 1;
  env.children[1].pid = 2;
  env.children[1].emit("error", new Error("kill EPERM"));
  const out = await poll;
  assert.equal(out.result.availability, AVAILABILITY.ERROR);
  let settled = false;
  out.settled.then(() => (settled = true));
  await flush();
  assert.equal(settled, false);
  env.timers[1].fn?.();
  await flush();
  assert.equal(settled, false);
  env.children[1].emit("exit", null, "SIGKILL");
  await out.settled;
  env.children[0].emit("close", 1, null);
  await pending;
});

test("verified spawn failure (no pid) and normal exit settle", async () => {
  const env = productionRunner();
  const poll = env.adapter.poll();
  env.children[0].emit("error", new Error("ENOENT"));
  const out = await poll;
  assert.equal(out.result.availability, AVAILABILITY.ERROR);
  await out.settled;
  const ok = productionRunner();
  const good = ok.adapter.poll();
  ok.children[0].pid = 3;
  ok.children[0].stdout.emit("data", Buffer.from(report));
  ok.children[0].emit("close", 0, null);
  await (
    await good
  ).settled;
});

test("abort after clean completion or before spawn is inert", async () => {
  const env = productionRunner();
  const signal = abortable();
  const pending = env.adapter.poll({ signal });
  env.children[0].stdout.emit("data", Buffer.from(report));
  env.children[0].emit("close", 0, null);
  const out = await pending;
  assert.equal(out.result.availability, AVAILABILITY.READY);
  assert.equal(signal.listeners.length, 0);
  signal.abort();
  assert.deepEqual(env.children[0].signals, []);
  await out.settled;
  const pre = productionRunner();
  const aborted = abortable();
  aborted.aborted = true;
  const res = await pre.adapter.poll({ signal: aborted });
  assert.equal(res.meta.cancelled, true);
  assert.equal(pre.children.length, 0);
});

test("abort of an exited child does not re-kill and timeout is indeterminate, not cancelled", async () => {
  const env = productionRunner();
  const signal = abortable();
  const pending = env.adapter.poll({ signal });
  env.children[0].emit("exit", 0, null);
  signal.abort();
  assert.equal((await pending).meta.cancelled, true);
  assert.deepEqual(env.children[0].signals, []);
  const t = productionRunner();
  const p = t.adapter.poll({ signal: abortable() });
  t.timers[0].fn();
  const r = await p;
  assert.deepEqual(r.meta, { requireManualRetry: true });
  assert.deepEqual(t.children[0].signals, ["SIGKILL"]);
});
