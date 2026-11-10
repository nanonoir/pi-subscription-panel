const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  load,
  contracts,
  adapters,
  preferences,
  actions,
  notices,
  ALL,
  defaults,
  tick,
  deferred,
  tui,
} = require("./helpers/subscription-fixture.cjs");

const NOW = Date.parse("2026-01-01T12:00:00Z");
const loadedOf = (value = defaults(), readOnly = false) => ({
  preferences: value,
  readOnly,
  warnings: [],
});

function setup({ loaded, save } = {}) {
  const registrations = [];
  const saves = [];
  let loads = 0;
  const mod = load("subscription-panels", {
    "./quota-contracts.ts": contracts,
    "./provider-adapters.ts": adapters,
    "./preferences.ts": preferences,
    "./subscription-actions.ts": actions,
    "./quota-presentation.ts": {
      buildQuotaPanel: (result, options) => ({
        id: `panel:${result.providerId}`,
        result,
        options,
      }),
    },
    "pi-atelier/extensions/index.ts": {
      registerSidebarPanel(_pi, panel, options) {
        const entry = { panel, options, updates: 0, disposed: 0 };
        registrations.push(entry);
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
  });
  const controller = mod.createSubscriptionPanels(
    {},
    {
      load:
        loaded ??
        (async () => {
          loads++;
          return loadedOf();
        }),
      save:
        save ??
        (async (value) => {
          saves.push(value);
          return { saved: true, warnings: [] };
        }),
      now: () => NOW,
    },
  );
  return { controller, registrations, saves, loads: () => loads };
}

const byId = (registrations, id) =>
  registrations.filter((item) => item.panel.id === id).at(-1);
const claudeEvent = (utilization, timestamp, provider = "claude-code") => ({
  message: {
    role: "assistant",
    provider,
    diagnostics: [
      {
        type: "claude-code.rate-limit",
        timestamp,
        details: {
          unifiedWindows: { five_hour: { utilization, resetsAt: 1767290000 } },
        },
      },
    ],
  },
});
const claudeWindows = (registrations) =>
  byId(registrations, "panel:claude-code").panel.result.pools[0]?.windows ?? [];

test("start registers four fixed panels with initial states and options", async () => {
  const { controller, registrations, saves, loads } = setup();
  await controller.start({ mode: "rpc" });
  await controller.start(undefined);
  assert.equal(loads(), 0);
  assert.equal(registrations.length, 0);
  await controller.start(tui());
  assert.deepEqual(
    registrations.map((item) => item.panel.id),
    ALL.map((id) => `panel:${id}`),
  );
  assert.ok(
    registrations.every(
      (item) => item.options.source === "subscription-limits",
    ),
  );
  assert.deepEqual(registrations[0].panel.options, {
    expanded: true,
    displayUsed: false,
    now: NOW,
    staleAfterMs: 180_000,
  });
  assert.equal(registrations[0].panel.result.availability, "waiting");
  const agy = registrations[2].panel.result;
  assert.equal(agy.availability, "unavailable");
  assert.match(agy.detail, /disabled/);
  assert.equal(saves.length, 0);
});

test("antigravity auto mode waits for a later refresh", async () => {
  const prefs = defaults();
  prefs.refresh.antigravity.mode = "auto";
  const { controller, registrations } = setup({
    loaded: async () => loadedOf(prefs),
  });
  await controller.start(tui());
  const agy = registrations[2].panel.result;
  assert.equal(agy.availability, "waiting");
  assert.match(agy.detail, /Awaiting refresh/);
});

test("restart and repeated stop dispose every handle once", async () => {
  const { controller, registrations } = setup();
  await controller.start(tui());
  await controller.start(tui());
  assert.equal(registrations.length, 8);
  assert.ok(registrations.slice(0, 4).every((item) => item.disposed === 1));
  controller.stop();
  controller.stop();
  assert.ok(registrations.every((item) => item.disposed === 1));
  controller.update({
    providerId: "codex",
    availability: "waiting",
    pools: [],
  });
  controller.render();
  assert.ok(registrations.every((item) => item.updates === 0));
});

test("a stop during the load registers nothing and commands stay inert", async () => {
  const gate = deferred();
  const { controller, registrations } = setup({ loaded: () => gate.promise });
  const pending = controller.start(tui());
  await tick();
  controller.stop();
  gate.resolve(loadedOf());
  await pending;
  assert.equal(registrations.length, 0);
  await controller.command("toggle codex", tui());
  assert.equal(registrations.length, 0);
});

test("load warnings are surfaced generically", async () => {
  notices.length = 0;
  const { controller } = setup({
    loaded: async () => ({
      preferences: defaults(),
      readOnly: true,
      warnings: [
        { code: "malformed", message: "Preferences file is not valid." },
      ],
    }),
  });
  await controller.start(tui());
  assert.deepEqual(notices, ["Preferences file is not valid."]);
});

test("a rejected load falls back to protected defaults with a warning", async () => {
  notices.length = 0;
  const { controller, registrations, saves } = setup({
    loaded: async () => {
      throw new Error("disk");
    },
  });
  await controller.start(tui());
  assert.deepEqual(notices, ["Preferences could not be read."]);
  assert.equal(registrations.length, 4);
  await controller.command("toggle codex", tui());
  assert.equal(saves.length, 0);
  assert.equal(registrations[0].panel.options.expanded, false);
});

test("commands only act in an active TUI session and re-render without disposing", async () => {
  const { controller, registrations, saves } = setup();
  await controller.command("toggle codex", tui());
  await controller.start(tui());
  await controller.command("toggle codex", { mode: "rpc" });
  assert.ok(registrations.every((item) => item.updates === 0));
  await controller.command("toggle codex", tui());
  assert.equal(
    byId(registrations, "panel:codex").panel.options.expanded,
    false,
  );
  assert.equal(
    byId(registrations, "panel:claude-code").panel.options.expanded,
    true,
  );
  await controller.command("display used", tui());
  assert.ok(registrations.every((item) => item.panel.options.displayUsed));
  assert.ok(registrations.every((item) => item.disposed === 0));
  await tick();
  assert.equal(saves.length, 2);
});

test("saved preferences are applied by the next start", async () => {
  const first = setup();
  await first.controller.start(tui());
  await first.controller.command("toggle codex", tui());
  await tick();
  const reloaded = setup({ loaded: async () => loadedOf(first.saves[0]) });
  await reloaded.controller.start(tui());
  assert.equal(reloaded.registrations[0].panel.options.expanded, false);
  assert.equal(reloaded.registrations[1].panel.options.expanded, true);
});

test("a menu answered after a restart changes nothing", async () => {
  const { controller, registrations, saves } = setup();
  await controller.start(tui());
  const pick = deferred();
  const pending = controller.command("", tui({ select: () => pick.promise }));
  await controller.start(tui());
  pick.resolve("Codex — collapse details");
  await pending;
  await tick();
  assert.equal(saves.length, 0);
  assert.ok(registrations.every((item) => item.updates === 0));
});

test("Claude messages merge partial windows and respect provider and activity", async () => {
  const { controller, registrations } = setup();
  controller.observeMessage(claudeEvent(0.2, NOW - 60_000));
  await controller.start(tui());
  controller.observeMessage(claudeEvent(0.2, NOW - 60_000, "anthropic"));
  controller.observeMessage({ message: { role: "user" } });
  assert.equal(byId(registrations, "panel:claude-code").updates, 0);
  assert.equal(claudeWindows(registrations).length, 0);
  controller.observeMessage(claudeEvent(0.2, NOW - 120_000));
  controller.observeMessage(claudeEvent(0.4, NOW - 60_000));
  controller.update({
    providerId: "claude-code",
    availability: "ready",
    pools: [
      {
        id: "default",
        windows: [
          {
            kind: "1w",
            remainingPercent: 50,
            observedAt: new Date(NOW - 30_000).toISOString(),
            source: "response-event",
          },
        ],
      },
    ],
  });
  const windows = claudeWindows(registrations);
  assert.deepEqual(
    windows.map((item) => [item.kind, item.observedAt]),
    [
      ["5h", new Date(NOW - 60_000).toISOString()],
      ["1w", new Date(NOW - 30_000).toISOString()],
    ],
  );
  assert.equal(windows[0].remainingPercent, 60);
  assert.equal(byId(registrations, "panel:codex").updates, 0);
});

test("observations during the load are merged and rendered at initialization", async () => {
  const gate = deferred();
  const { controller, registrations } = setup({ loaded: () => gate.promise });
  const pending = controller.start(tui());
  await tick();
  controller.observeMessage(claudeEvent(0.2, NOW - 120_000));
  controller.observeMessage(claudeEvent(0.4, NOW - 60_000));
  controller.observeMessage(claudeEvent(0.9, NOW - 180_000));
  controller.update({
    providerId: "claude-code",
    availability: "ready",
    pools: [
      {
        id: "default",
        windows: [
          {
            kind: "1w",
            remainingPercent: 50,
            observedAt: new Date(NOW - 30_000).toISOString(),
            source: "response-event",
          },
        ],
      },
    ],
  });
  controller.observeMessage(claudeEvent(0.1, NOW, "anthropic"));
  assert.equal(registrations.length, 0);
  gate.resolve(loadedOf());
  await pending;
  assert.equal(registrations.length, 4);
  assert.ok(registrations.every((item) => item.updates === 0));
  const claude = byId(registrations, "panel:claude-code").panel.result;
  assert.equal(claude.availability, "ready");
  assert.deepEqual(
    claude.pools[0].windows.map((item) => [
      item.kind,
      item.observedAt,
      item.remainingPercent,
    ]),
    [
      ["5h", new Date(NOW - 60_000).toISOString(), 60],
      ["1w", new Date(NOW - 30_000).toISOString(), 50],
    ],
  );
  assert.equal(
    byId(registrations, "panel:codex").panel.result.availability,
    "waiting",
  );
});

test("buffered observations are discarded by stop and by restart", async () => {
  const stopGate = deferred();
  const stopped = setup({ loaded: () => stopGate.promise });
  const first = stopped.controller.start(tui());
  await tick();
  stopped.controller.observeMessage(claudeEvent(0.2, NOW - 60_000));
  stopped.controller.stop();
  stopGate.resolve(loadedOf());
  await first;
  assert.equal(stopped.registrations.length, 0);

  const gates = [deferred(), deferred()];
  let call = 0;
  const restarted = setup({ loaded: () => gates[call++].promise });
  const older = restarted.controller.start(tui());
  await tick();
  restarted.controller.observeMessage(claudeEvent(0.2, NOW - 60_000));
  const newer = restarted.controller.start(tui());
  await tick();
  gates[0].resolve(loadedOf());
  gates[1].resolve(loadedOf());
  await Promise.all([older, newer]);
  assert.equal(restarted.registrations.length, 4);
  assert.equal(claudeWindows(restarted.registrations).length, 0);
  assert.equal(
    byId(restarted.registrations, "panel:claude-code").panel.result
      .availability,
    "waiting",
  );
});

test("start loads only after queued saves settle, in order", async () => {
  const order = [];
  const saveGate = deferred();
  const { controller, registrations } = setup({
    save: async () => {
      order.push("save-start");
      await saveGate.promise;
      order.push("save-end");
      return { saved: true, warnings: [] };
    },
    loaded: async () => {
      order.push("load");
      return loadedOf();
    },
  });
  await controller.start(tui());
  await controller.command("toggle codex", tui());
  const restart = controller.start(tui());
  await tick();
  assert.deepEqual(order, ["load", "save-start"]);
  saveGate.resolve();
  await restart;
  assert.deepEqual(order, ["load", "save-start", "save-end", "load"]);
  assert.equal(registrations.length, 8);
});

test("a start cancelled while saves are pending never loads", async () => {
  const saveGate = deferred();
  let loads = 0;
  const { controller, registrations } = setup({
    save: async () => {
      await saveGate.promise;
      return { saved: true, warnings: [] };
    },
    loaded: async () => {
      loads++;
      return loadedOf();
    },
  });
  await controller.start(tui());
  assert.equal(loads, 1);
  await controller.command("toggle codex", tui());
  const restart = controller.start(tui());
  await tick();
  controller.stop();
  saveGate.resolve();
  await restart;
  await tick();
  assert.equal(loads, 1);
  assert.equal(registrations.length, 4);
  assert.ok(registrations.every((item) => item.disposed === 1));

  const later = controller.start({ mode: "rpc" });
  await later;
  assert.equal(loads, 1);
});
