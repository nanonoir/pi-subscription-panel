const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function fixture() {
  const source = fs.readFileSync(
    path.join(__dirname, "manual/atelier-interaction.ts"),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const events = {};
  const commands = {};
  const registrations = [];
  const sandbox = {
    exports: {},
    require(name) {
      assert.equal(name, "pi-atelier/extensions/index.ts");
      return {
        registerSidebarPanel(_pi, panel) {
          const entry = { panel, updates: 0, disposed: 0 };
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
      };
    },
  };
  vm.runInNewContext(compiled, sandbox);
  sandbox.exports.default({
    on(name, handler) {
      events[name] = handler;
    },
    registerCommand(name, options) {
      commands[name] = options.handler;
    },
  });
  return { events, command: commands["subscriptions-spike"], registrations };
}

const tui = { mode: "tui" };

test("three fictional panels toggle independently and retain title and summary", async () => {
  const { events, command, registrations } = fixture();
  events.session_start({}, tui);
  assert.deepEqual(
    registrations.map((item) => item.panel.id),
    [
      "subscription-spike:codex",
      "subscription-spike:claude-code",
      "subscription-spike:antigravity",
    ],
  );
  for (const [index, name] of [
    "Codex",
    "Claude Code",
    "Antigravity",
  ].entries()) {
    const panel = registrations[index].panel;
    assert.match(panel.title, new RegExp(name));
    assert.match(panel.title, /TEST/);
    assert.equal(panel.keyValues.length, 3);
    assert.ok(panel.keyValues.every((row) => row.label.includes("TEST DATA")));
    assert.match(panel.keyValues[1].value, /remaining/);
    assert.match(panel.keyValues[2].value, /remaining/);
  }
  const before = registrations.map((item) => item.panel);
  await command("toggle codex", tui);
  assert.equal(registrations[0].panel.title, before[0].title);
  assert.deepEqual(registrations[0].panel.keyValues[0], before[0].keyValues[0]);
  assert.equal(registrations[0].panel.keyValues.length, 1);
  assert.equal(registrations[1].panel, before[1]);
  assert.equal(registrations[2].panel, before[2]);
  await command("", {
    ...tui,
    ui: { select: async (_title, options) => options[1] },
  });
  assert.equal(registrations[1].panel.keyValues.length, 1);
  assert.equal(registrations[0].panel.keyValues.length, 1);
  await command("toggle codex", tui);
  assert.equal(registrations[0].panel.keyValues.length, 3);
  assert.ok(registrations.every((item) => item.disposed === 0));
});

test("invalid commands, cancelled menus and missing UI leave panels unchanged", async () => {
  const { events, command, registrations } = fixture();
  events.session_start({}, tui);
  for (const args of ["toggle unknown", "toggle codex extra", "other"]) {
    await command(args, tui);
  }
  await command("", tui);
  await command("", { ...tui, ui: { select: async () => undefined } });
  await command("", { ...tui, ui: { select: async () => "unexpected" } });
  assert.ok(registrations.every((item) => item.updates === 0));
});

test("non-TUI, restarts and shutdown safely clean up; stale menu cannot toggle", async () => {
  const { events, command, registrations } = fixture();
  events.session_start({}, { mode: "rpc" });
  events.session_start({}, undefined);
  await command("toggle codex", { mode: "rpc" });
  assert.equal(registrations.length, 0);
  events.session_start({}, tui);
  await command("toggle codex", tui);
  let resolve;
  const pending = command("", {
    ...tui,
    ui: {
      select: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  events.session_start({}, tui);
  resolve("Codex — expand TEST DATA");
  await pending;
  assert.ok(registrations.slice(0, 3).every((item) => item.disposed === 1));
  assert.ok(
    registrations
      .slice(3)
      .every((item) => item.panel.keyValues.length === 3 && item.updates === 0),
  );
  events.session_shutdown();
  events.session_shutdown();
  assert.ok(registrations.every((item) => item.disposed === 1));
  await command("toggle codex", tui);
  assert.ok(registrations.slice(3).every((item) => item.updates === 0));
});
