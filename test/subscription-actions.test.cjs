const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  actions: { createSubscriptionActions, PROVIDERS },
  preferences,
  notices,
  ALL,
  tick,
  tui,
} = require("./helpers/subscription-fixture.cjs");

function setup({ save, readOnly = false } = {}) {
  const saves = [];
  const changes = [];
  const actions = createSubscriptionActions({
    save:
      save ??
      (async (value) => {
        saves.push(value);
        return { saved: true, warnings: [] };
      }),
    onChange: (value) => changes.push(value),
  });
  actions.configure({
    preferences: preferences.defaultPreferences(),
    readOnly,
  });
  return { actions, saves, changes };
}

test("providers keep the fixed order", () => {
  assert.deepEqual(
    PROVIDERS.map((item) => item.id),
    ALL,
  );
});

test("toggle and display are independent, normalized and persisted in order", async () => {
  const { actions, saves, changes } = setup();
  await actions.command("toggle codex", tui());
  assert.deepEqual(actions.get().expandedProviders, ALL.slice(1));
  assert.equal(actions.get().displayMode, "remaining");
  await actions.command("display used", tui());
  await actions.command("display used", tui());
  await actions.command("toggle codex", tui());
  await actions.flush();
  assert.equal(changes.length, 3);
  assert.deepEqual(
    saves.map((item) => [item.displayMode, item.expandedProviders.length]),
    [
      ["remaining", 3],
      ["used", 3],
      ["used", 4],
    ],
  );
  assert.deepEqual(saves[0].expandedProviders, ALL.slice(1));
});

test("menu selection toggles a provider or the display mode", async () => {
  const { actions, saves } = setup();
  let shown;
  await actions.command(
    "",
    tui({
      select: async (_title, list) => {
        shown = list;
        return list[1];
      },
    }),
  );
  assert.equal(shown.length, 5);
  assert.deepEqual(actions.get().expandedProviders, [
    "codex",
    "antigravity",
    "anthropic",
  ]);
  await actions.command("", tui({ select: async (_t, list) => list[4] }));
  assert.equal(actions.get().displayMode, "used");
  await actions.flush();
  assert.equal(saves.length, 2);
});

test("invalid input, cancelled menus and missing select change nothing", async () => {
  notices.length = 0;
  const { actions, saves, changes } = setup();
  for (const bad of ["toggle nope", "toggle codex x", "display none", "other"])
    await actions.command(bad, tui());
  await actions.command("", tui({ select: async () => undefined }));
  await actions.command("", tui({ select: async () => "unexpected" }));
  await actions.command("", tui());
  await actions.flush();
  assert.equal(notices.filter((text) => /Usage/.test(text)).length, 4);
  assert.equal(saves.length, 0);
  assert.equal(changes.length, 0);
});

test("a menu answered after the guard turned stale changes nothing", async () => {
  const { actions, saves, changes } = setup();
  let current = true;
  let pick;
  const pending = actions.command(
    "",
    tui({ select: () => new Promise((done) => (pick = done)) }),
    () => current,
  );
  current = false;
  pick("Codex — collapse details");
  await pending;
  await actions.flush();
  assert.equal(changes.length, 0);
  assert.equal(saves.length, 0);
});

test("failed saves warn truthfully while the change stays applied", async () => {
  notices.length = 0;
  const { actions } = setup({
    save: async () => ({
      saved: false,
      warnings: [
        { code: "write-failed", message: "Preferences could not be saved." },
      ],
    }),
  });
  await actions.command("toggle codex", tui());
  await actions.flush();
  assert.match(
    notices.at(-1),
    /could not be saved\. The change applies to this session only/,
  );
  assert.equal(actions.get().expandedProviders.includes("codex"), false);
});

test("protected preferences are never saved but still change the session", async () => {
  notices.length = 0;
  const { actions, saves, changes } = setup({ readOnly: true });
  await actions.command("toggle codex", tui());
  await actions.flush();
  assert.equal(saves.length, 0);
  assert.equal(changes.length, 1);
  assert.match(notices.at(-1), /protected.*this session only/);
});

test("saves run serially, a throwing save does not block the queue, flush waits", async () => {
  const order = [];
  const gates = [];
  const { actions } = setup({
    save: (value) =>
      new Promise((done, fail) => {
        order.push(`start:${value.displayMode}`);
        gates.push(() => {
          order.push(`end:${value.displayMode}`);
          if (value.displayMode === "used") fail(new Error("boom"));
          else done({ saved: true, warnings: [] });
        });
      }),
  });
  await actions.command("display used", tui());
  await actions.command("display remaining", tui());
  let flushed = false;
  const waiting = actions.flush().then(() => (flushed = true));
  await tick();
  assert.deepEqual(order, ["start:used"]);
  gates[0]();
  await tick();
  assert.deepEqual(order, ["start:used", "end:used", "start:remaining"]);
  assert.equal(flushed, false);
  gates[1]();
  await waiting;
  assert.equal(order.at(-1), "end:remaining");
});
