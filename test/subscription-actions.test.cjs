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

test("toggle is normalized and persisted in order; legacy display command only explains", async () => {
  notices.length = 0;
  const { actions, saves, changes } = setup();
  await actions.command("toggle codex", tui());
  assert.deepEqual(actions.get().expandedProviders, ALL.slice(1));
  await actions.command("display used", tui());
  await actions.command("display remaining", tui());
  assert.equal(
    notices.filter((text) => /always show remaining/.test(text)).length,
    2,
  );
  assert.equal(actions.get().displayMode, "remaining");
  await actions.command("toggle codex", tui());
  await actions.flush();
  assert.equal(changes.length, 2);
  assert.deepEqual(
    saves.map((item) => item.expandedProviders.length),
    [3, 4],
  );
  assert.deepEqual(saves[0].expandedProviders, ALL.slice(1));
});

test("a saved legacy display mode is preserved across other changes", async () => {
  const saves = [];
  const actions = createSubscriptionActions({
    save: async (value) => {
      saves.push(value);
      return { saved: true, warnings: [] };
    },
    onChange: () => {},
  });
  actions.configure({
    preferences: { ...preferences.defaultPreferences(), displayMode: "used" },
    readOnly: false,
  });
  await actions.command("display remaining", tui());
  await actions.command("toggle codex", tui());
  await actions.flush();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].displayMode, "used");
});

test("menu selection toggles a provider and offers no display entry", async () => {
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
  assert.ok(shown.every((label) => !/Display/.test(label)));
  assert.deepEqual(actions.get().expandedProviders, [
    "codex",
    "antigravity",
    "anthropic",
  ]);
  await actions.flush();
  assert.equal(saves.length, 1);
});

test("menu entry enables and disables Antigravity refresh, persisted, without a retry", async () => {
  const retries = [];
  const saves = [];
  const actions = createSubscriptionActions({
    save: async (value) => {
      saves.push(value);
      return { saved: true, warnings: [] };
    },
    onChange: () => {},
    retry: (id) => {
      retries.push(id);
      return { status: "started" };
    },
  });
  actions.configure({
    preferences: preferences.defaultPreferences(),
    readOnly: false,
  });
  const labels = [];
  const pick = tui({
    select: async (_t, list) => {
      labels.push(list[4]);
      return list[4];
    },
  });
  await actions.command("", pick);
  assert.equal(actions.get().refresh.antigravity.mode, "auto");
  await actions.command("", pick);
  assert.equal(actions.get().refresh.antigravity.mode, "off");
  await actions.flush();
  assert.match(labels[0], /enable/);
  assert.match(labels[1], /disable/);
  assert.deepEqual(
    saves.map((item) => item.refresh.antigravity.mode),
    ["auto", "off"],
  );
  assert.equal(retries.length, 0);
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
        const tag = value.expandedProviders.length;
        order.push(`start:${tag}`);
        gates.push(() => {
          order.push(`end:${tag}`);
          if (tag === 3) fail(new Error("boom"));
          else done({ saved: true, warnings: [] });
        });
      }),
  });
  await actions.command("toggle codex", tui());
  await actions.command("toggle codex", tui());
  let flushed = false;
  const waiting = actions.flush().then(() => (flushed = true));
  await tick();
  assert.deepEqual(order, ["start:3"]);
  gates[0]();
  await tick();
  assert.deepEqual(order, ["start:3", "end:3", "start:4"]);
  assert.equal(flushed, false);
  gates[1]();
  await waiting;
  assert.equal(order.at(-1), "end:4");
});

test("refresh settings are independent of expansion, persisted and idempotent", async () => {
  const { actions, saves, changes } = setup();
  await actions.command("refresh antigravity on", tui());
  assert.equal(actions.get().refresh.antigravity.mode, "auto");
  assert.equal(actions.get().refresh.antigravity.activeSeconds, 180);
  await actions.command("refresh antigravity on", tui());
  await actions.command("refresh collapsed off", tui());
  assert.equal(actions.get().refresh.whileCollapsed, false);
  assert.deepEqual(actions.get().expandedProviders, ALL);
  await actions.command("toggle codex", tui());
  assert.equal(actions.get().refresh.whileCollapsed, false);
  await actions.command("refresh antigravity off", tui());
  await actions.flush();
  assert.equal(actions.get().refresh.antigravity.mode, "off");
  assert.equal(changes.length, 4);
  assert.equal(saves.at(-1).refresh.whileCollapsed, false);
});

test("retry reports each scheduler status without changing preferences", async () => {
  notices.length = 0;
  const asked = [];
  let result = { status: "started" };
  const actions = createSubscriptionActions({
    save: async () => ({ saved: true, warnings: [] }),
    onChange: () => assert.fail("retry must not change preferences"),
    retry: (id) => (asked.push(id), result),
  });
  for (const next of [
    { status: "started" },
    { status: "deferred", eligibleAtMs: Date.parse("2026-01-01T12:34:56Z") },
    { status: "in-flight" },
    { status: "disabled" },
    { status: "stopped" },
  ]) {
    result = next;
    await actions.command("retry codex", tui());
  }
  assert.deepEqual(asked, Array(5).fill("codex"));
  assert.match(notices[0], /started/);
  assert.match(notices[1], /deferred until 12:34:56 UTC.*no request was made/);
  assert.match(notices[2], /already in progress/);
  assert.match(notices[3], /off or paused while collapsed/);
  assert.match(notices[4], /not available right now/);
});

test("retry without a scheduler is unavailable; Claude Code routes through retry", async () => {
  notices.length = 0;
  const { actions } = setup();
  await actions.command("retry anthropic", tui());
  assert.match(notices.at(-1), /not available right now/);
  const calls = [];
  const claude = createSubscriptionActions({
    save: async () => ({ saved: true, warnings: [] }),
    onChange: () => {},
    retry: (id) => (calls.push(id), { status: "started" }),
  });
  await claude.command("retry claude-code", tui());
  assert.deepEqual(calls, ["claude-code"]);
  assert.match(notices.at(-1), /Claude Code: quota refresh started/);
  assert.doesNotMatch(notices.at(-1), /never queried/);
});

test("status reports a legacy failure as unknown, never an old success or raw error text", async () => {
  notices.length = 0;
  const now = Date.parse("2026-01-01T12:00:00Z");
  const schedule = {
    lastSuccessMs: now - 3_600_000,
    nextEligibleMs: now,
    inFlight: false,
    failureCount: 2,
    lastError: "raw Bearer sk-secret /home/user/.token",
    recentlyActive: false,
  };
  const actions = createSubscriptionActions({
    save: async () => ({ saved: true, warnings: [] }),
    onChange: () => {},
    now: () => now,
    status: () => [{ id: "codex", enabled: true, schedule }],
  });
  await actions.command("status", tui());
  const shown = notices.at(-1);
  assert.match(shown, /Codex: polling on · last read failed: reason unknown/);
  assert.doesNotMatch(shown, /last success|no read result|secret|Bearer/);
});

test("status for a blocked provider requires manual retry and lists deadlines as constraints", async () => {
  notices.length = 0;
  const now = Date.parse("2026-01-01T12:00:00Z");
  const server = now + 600_000;
  const schedule = {
    lastSuccessMs: now - 3_600_000,
    nextEligibleMs: server,
    serverRetryAtMs: server,
    deferral: { cause: "server", untilMs: server },
    inFlight: false,
    failureCount: 1,
    blocked: "authentication",
    recentlyActive: false,
  };
  const actions = createSubscriptionActions({
    save: async () => ({ saved: true, warnings: [] }),
    onChange: () => {},
    now: () => now,
    status: () => [{ id: "codex", enabled: true, schedule }],
  });
  await actions.command("status", tui());
  const shown = notices.at(-1);
  assert.match(shown, /paused \(authentication\)/);
  assert.match(shown, /last read failed: reason unknown/);
  assert.match(shown, /server deadline 2026-01-01 12:10:00 UTC/);
  assert.match(shown, /manual retry required/);
  assert.doesNotMatch(shown, /next read after/);
});
