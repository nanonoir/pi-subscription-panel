const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { loadRuntime, START } = require("./helpers/runtime-loader.cjs");

// Synthetic only: no real credential file, network, disk write or Pi session.
const USAGE = "https://api.anthropic.com/api/oauth/usage";
const WHAM = "https://chatgpt.com/backend-api/wham/usage";
const CC_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const MEMORY_KEY = Symbol.for("pi-subscription-panel.quota-memory.v1");
const jwt = (account) =>
  `h.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    }),
  ).toString("base64url")}.s`;
const tick = () => new Promise((done) => setImmediate(done));
const text = (entry) => JSON.stringify(entry.panel);
const panel = (env, id) =>
  env.registrations.filter((item) => item.panel.id === id).at(-1);
const codex = (env) => text(panel(env, "subscription:limits"));
const claude = (env) => text(panel(env, "subscription:claude-code"));
const MIN = 60_000;

/** Mutable world shared by every load, like the one process behind a reload. */
function world(overrides = {}) {
  return {
    now: START,
    sandbox: undefined,
    agentDir: "synthetic-agent-dir",
    ccToken: "synthetic-claude-code-token",
    account: "acct-A",
    prefs: undefined,
    codexStatus: 200,
    claudeStatus: 200,
    claudePercent: 20,
    codexPercent: 25,
    hold: {},
    ...overrides,
  };
}

const credentialFor = (w) =>
  w.account === undefined
    ? undefined
    : { type: "oauth", access: jwt(w.account), accountId: w.account };

/** One module load (a fresh evaluation when `w.sandbox` is already set). */
function boot(w, provider = "openai") {
  const options = {
    expose: "",
    agentDir: w.agentDir,
    credential: () => credentialFor(w),
    sandbox: w.sandbox,
    lstat: async () => ({ isFile: () => true, size: 100, mode: 0o100600 }),
    readFile: async (target) => {
      if (target === CC_PATH)
        return JSON.stringify({ claudeAiOauth: { accessToken: w.ccToken } });
      if (String(target).endsWith("subscription-panel.json") && w.prefs)
        return JSON.stringify(w.prefs);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    fetch: async (url, init) => {
      if (w.hold[url]) return w.hold[url].promise.then((r) => r.clone());
      if (url === WHAM) {
        if (w.codexStatus !== 200)
          return new Response("", { status: w.codexStatus });
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: w.codexPercent,
              limit_window_seconds: 18000,
              resets_at: (START + 4 * 3_600_000) / 1000,
            },
          },
        });
      }
      if (init.headers.Authorization === `Bearer ${w.ccToken}`) {
        if (w.claudeStatus !== 200)
          return new Response("", {
            status: w.claudeStatus,
            headers: { "retry-after": "900" },
          });
        return Response.json({
          five_hour: {
            utilization: w.claudePercent,
            resets_at: "2026-01-01T15:00:00Z",
          },
          seven_day: { utilization: 35, resets_at: "2026-01-05T00:00:00Z" },
        });
      }
      return Response.json({ five_hour: { utilization: 10, resets_at: null } });
    },
  };
  // Credential is read lazily by the mock, so keep it current across a load.
  const loaded = loadRuntime(options);
  w.sandbox = loaded.sandbox;
  loaded.env.now = w.now;
  const handlers = {};
  loaded.entry.default({
    on: (event, handler) => (handlers[event] = handler),
    registerCommand() {},
  });
  const ctx = {
    mode: "tui",
    model: { provider },
    ui: { notify() {} },
    modelRegistry: {
      getProviderAuth: async () => ({
        source: "OAuth",
        // What Pi resolves; `authAccount` models a divergence from the store.
        auth: {
          apiKey: jwt(w.authAccount ?? w.account ?? "synthetic-account"),
        },
      }),
    },
  };
  const h = { ...loaded, handlers, ctx, options };
  h.start = async () => {
    await h.handlers.session_start({}, ctx);
    await tick();
  };
  h.advance = async (ms) => {
    w.now += ms;
    h.env.now = w.now;
    h.env.intervals.at(-1).fn();
    await tick();
  };
  h.reads = (url) => h.env.requests.filter((u) => u === url).length;
  return h;
}

/** A reload as Pi performs it: old instance shuts down, a new module loads. */
async function reload(w, h, ms = 0, provider) {
  await h.handlers.session_shutdown();
  w.now += ms;
  const next = boot(w, provider);
  await next.start();
  return next;
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

test("a reload within the gap shows the last quotas immediately, with no request", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  assert.match(codex(first.env), /75% left/);
  assert.match(claude(first.env), /80% left/);

  const second = await reload(w, first, 20_000);
  // Real module reload: a new evaluation found the shared in-memory entries.
  assert.notEqual(second.entry, first.entry);
  assert.equal(second.reads(WHAM), 0);
  assert.equal(second.reads(USAGE), 0);
  assert.match(codex(second.env), /75% left/);
  assert.match(claude(second.env), /80% left/);
  assert.match(claude(second.env), /1w/);
  // Not a waiting state, and the gap still applies: nothing is read yet.
  await second.advance(30_000);
  assert.equal(second.reads(WHAM), 0);
});

test("restored windows keep their original observation time, source and failure state", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  // Claude Code becomes eligible after its five-minute gap and is rate limited.
  w.claudeStatus = 429;
  await first.advance(5 * MIN + 1_000);
  assert.ok(first.reads(USAGE) >= 2);

  // Reload at +7m: the reading is 7 minutes old (stale after 6), not "now".
  const second = await reload(w, first, 2 * MIN - 1_000);
  assert.equal(second.reads(USAGE), 0);
  const shown = claude(second.env);
  assert.match(shown, /80% left/);
  assert.match(shown, /STALE/);
  assert.match(shown, /7m ago/);
  assert.match(shown, /429/);
  assert.match(shown, /server deadline/);
});

test("an eligible startup read is not suppressed and replaces the restored values", async () => {
  const w = world();
  const first = boot(w);
  await first.start();

  // Both gaps have passed at the reload: restoring must not stop the reads.
  w.hold[USAGE] = deferred();
  w.claudePercent = 50;
  await first.handlers.session_shutdown();
  w.now += 6 * MIN;
  const second = boot(w);
  await second.start();
  assert.ok(second.reads(USAGE) >= 1);
  assert.equal(second.reads(WHAM), 1);
  // The retained windows are visible while the read is pending.
  assert.match(claude(second.env), /80% left/);
  w.hold[USAGE].resolve(
    Response.json({
      five_hour: { utilization: 50, resets_at: "2026-01-01T15:00:00Z" },
      seven_day: { utilization: 35, resets_at: "2026-01-05T00:00:00Z" },
    }),
  );
  delete w.hold[USAGE];
  await tick();
  await tick();
  assert.doesNotMatch(claude(second.env), /80% left/);
  assert.match(claude(second.env), /50% left/);
});

test("a changed or unavailable authentication context invalidates retention", async () => {
  // Claude Code session changed: not restored, and the entry is gone for good.
  const w = world();
  const first = boot(w);
  await first.start();
  w.ccToken = "another-session-token";
  const second = await reload(w, first, 20_000);
  assert.doesNotMatch(claude(second.env), /80% left/);
  assert.match(claude(second.env), /minimum refresh gap/);
  w.ccToken = "synthetic-claude-code-token";
  const third = await reload(w, second, 1_000);
  assert.doesNotMatch(claude(third.env), /80% left/);

  // Codex account changed.
  const x = world();
  const one = boot(x);
  await one.start();
  x.account = "acct-B";
  const two = await reload(x, one, 20_000);
  assert.doesNotMatch(codex(two.env), /75% left/);
  x.account = "acct-A";
  const back = await reload(x, two, 1_000);
  assert.doesNotMatch(codex(back.env), /75% left/);

  // No provable identity at all (no stored credential): nothing is retained.
  const y = world({ account: undefined });
  const a = boot(y);
  await a.start();
  assert.match(codex(a.env), /75% left/);
  y.account = "acct-A";
  const b = await reload(y, a, 20_000);
  assert.doesNotMatch(codex(b.env), /75% left/);
});

test("entries are separated per agent-directory scope", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  // A new scope has no attempt history, so it reads at once: distinct values
  // show that the first scope's windows were never carried over.
  w.claudePercent = 60;
  w.codexPercent = 30;
  w.agentDir = "another-agent-dir";
  const other = await reload(w, first, 20_000);
  assert.doesNotMatch(claude(other.env), /80% left/);
  assert.doesNotMatch(codex(other.env), /75% left/);
  assert.match(claude(other.env), /40% left/);
  assert.match(codex(other.env), /70% left/);
  // The first scope's entries were not touched by the other scope.
  w.agentDir = "synthetic-agent-dir";
  const home = await reload(w, other, 1_000);
  assert.match(claude(home.env), /80% left/);
  assert.match(codex(home.env), /75% left/);
});

test("authentication failures forget retained quotas; other failures keep them", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  w.codexStatus = 401;
  await first.advance(61_000);
  const second = await reload(w, first, 1_000);
  assert.equal(second.reads(WHAM), 0);
  assert.doesNotMatch(codex(second.env), /75% left/);
  // A recoverable failure on the same provider kept its windows (above test);
  // here the other provider is untouched.
  assert.match(claude(second.env), /80% left/);
});

test("a passive observation that arrives first is not overwritten", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  await first.handlers.session_shutdown();
  w.now += 20_000;
  const second = boot(w);
  const started = second.handlers.session_start({}, second.ctx);
  // Arrives while preferences are loading, before the runtime starts.
  second.handlers.after_provider_response(
    {
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "60",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String((START + 4 * 3_600_000) / 1000),
      },
    },
    second.ctx,
  );
  await started;
  await tick();
  assert.match(codex(second.env), /40% left/);
  assert.doesNotMatch(codex(second.env), /75% left/);
});

test("providers that are off for refresh are not restored", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  w.prefs = {
    schemaVersion: 1,
    expandedProviders: ["codex"],
    refresh: { whileCollapsed: false },
  };
  const second = await reload(w, first, 20_000);
  assert.match(codex(second.env), /75% left/);
  assert.doesNotMatch(claude(second.env), /80% left/);
  // Antigravity stays opt-in: it is neither read nor restored.
  assert.equal(second.env.requests.length, 0);
  assert.match(
    text(panel(second.env, "subscription:antigravity")),
    /Unavailable/,
  );
});

test("a retired controller's late result records and restores nothing", async () => {
  const w = world();
  w.hold[WHAM] = deferred();
  const first = boot(w);
  await first.start();
  assert.equal(first.reads(WHAM), 1);
  await first.handlers.session_shutdown();
  w.hold[WHAM].resolve(
    Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18000,
          resets_at: (START + 4 * 3_600_000) / 1000,
        },
      },
    }),
  );
  delete w.hold[WHAM];
  await tick();
  await tick();
  const second = await reload(
    w,
    { handlers: { session_shutdown() {} } },
    5_000,
  );
  assert.doesNotMatch(codex(second.env), /75% left/);
  assert.equal(second.reads(WHAM), 0);
});

test("stop before a restore completes publishes nothing", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  await first.handlers.session_shutdown();
  w.now += 20_000;
  const second = boot(w);
  const started = second.handlers.session_start({}, second.ctx);
  await started;
  // Shut down immediately; any pending restore must not touch disposed panels.
  await second.handlers.session_shutdown();
  const updates = second.env.registrations.map((entry) => entry.updates);
  await tick();
  await tick();
  assert.deepEqual(
    second.env.registrations.map((entry) => entry.updates),
    updates,
  );
});

// ---- store-level bounds and registry versioning ----

function memory(sandbox) {
  const loaded = loadRuntime({
    entry: "quota-memory",
    ...(sandbox ? { sandbox } : {}),
  });
  return { ...loaded, store: loaded.entry.getQuotaMemory() };
}

const pools = (count = 1, observedAt = new Date(START).toISOString()) => [
  {
    id: "default",
    windows: Array.from({ length: count }, (_, index) => ({
      kind: `w${index}`,
      remainingPercent: 50,
      observedAt,
      source: "read-only-endpoint",
      resetsAt: new Date(START + 3_600_000).toISOString(),
    })),
  },
];

test("memory returns copies, requires the same context and keeps provenance", () => {
  const { store } = memory();
  const ctx = store.digest("codex", "secret-account");
  assert.doesNotMatch(ctx, /secret/);
  assert.notEqual(ctx, store.digest("claude-code", "secret-account"));
  assert.equal(ctx, store.digest("codex", "secret-account"));

  store.remember("scope", "codex", ctx, pools(), START);
  const got = store.recall("scope", "codex", ctx, START + MIN);
  assert.equal(got[0].windows[0].observedAt, new Date(START).toISOString());
  assert.equal(got[0].windows[0].source, "read-only-endpoint");
  got[0].windows[0].remainingPercent = 1;
  assert.equal(
    store.recall("scope", "codex", ctx, START + MIN)[0].windows[0]
      .remainingPercent,
    50,
  );
  // Another scope, provider or context never sees it.
  assert.equal(store.recall("other", "codex", ctx, START), undefined);
  assert.equal(store.recall("scope", "claude-code", ctx, START), undefined);
  assert.equal(
    store.recall("scope", "codex", store.digest("codex", "x"), START),
    undefined,
  );
  // A mismatch invalidated the entry; the right context no longer finds it.
  assert.equal(store.recall("scope", "codex", ctx, START), undefined);
  // An unprovable context forgets.
  store.remember("scope", "codex", ctx, pools(), START);
  assert.equal(store.recall("scope", "codex", undefined, START), undefined);
  assert.equal(store.recall("scope", "codex", ctx, START), undefined);
});

test("memory is bounded by age, reset, entry and window counts", () => {
  const { store } = memory();
  const ctx = store.digest("codex", "a");
  // Old observations expire; past-reset windows are not restored.
  store.remember("s", "codex", ctx, pools(1), START);
  assert.equal(store.recall("s", "codex", ctx, START + 61 * MIN), undefined);
  store.remember("s", "codex", ctx, pools(1), START);
  assert.equal(
    store.recall("s", "codex", ctx, START + 3_600_000 + 1),
    undefined,
  );

  // Too many windows are not retained at all.
  store.remember("s", "codex", ctx, pools(33), START);
  assert.equal(store.recall("s", "codex", ctx, START), undefined);
  store.remember("s", "codex", ctx, pools(32), START);
  assert.equal(store.recall("s", "codex", ctx, START).length, 1);

  // Entry cap: the oldest is evicted.
  for (let index = 0; index < 16; index++)
    store.remember(`scope-${index}`, "codex", ctx, pools(), START + index + 1);
  assert.equal(store.recall("s", "codex", ctx, START + 20), undefined);
  assert.ok(store.recall("scope-0", "codex", ctx, START + 20));
  store.remember("scope-new", "codex", ctx, pools(), START + 100);
  assert.equal(store.recall("scope-0", "codex", ctx, START + 101), undefined);
  assert.ok(store.recall("scope-15", "codex", ctx, START + 101));

  // Malformed input is dropped rather than stored.
  const bad = pools();
  bad[0].windows[0].remainingPercent = Number.NaN;
  store.remember("bad", "codex", ctx, bad, START);
  assert.equal(store.recall("bad", "codex", ctx, START), undefined);
});

test("memory registry is versioned and shared across module evaluations", () => {
  const one = memory();
  const ctx = one.store.digest("codex", "a");
  one.store.remember("s", "codex", ctx, pools(), START);
  // A second evaluation of the module in the same realm shares entries and key.
  const two = memory(one.sandbox);
  assert.equal(two.store.digest("codex", "a"), ctx);
  assert.ok(two.store.recall("s", "codex", ctx, START));

  // A foreign registry version at the key is replaced, never trusted.
  const seeded = {};
  seeded[MEMORY_KEY] = { version: 2, entries: new Map([["s\0codex", {}]]) };
  const three = memory(seeded);
  assert.equal(three.store.recall("s", "codex", ctx, START), undefined);
  three.store.remember("s", "codex", ctx, pools(), START);
  assert.ok(three.store.recall("s", "codex", ctx, START));
});

// ---- context bound to the credential the request actually used ----

test("a Codex read whose resolved account differs from the stored identity is not retained", async () => {
  const w = world({ authAccount: "acct-B" });
  const first = boot(w);
  await first.start();
  // The request itself ran and is shown, but identity could not be proven.
  assert.match(codex(first.env), /75% left/);
  w.authAccount = undefined;
  const second = await reload(w, first, 20_000);
  assert.equal(second.reads(WHAM), 0);
  assert.doesNotMatch(codex(second.env), /75% left/);
});

test("a credential that changes during the request is not retained", async () => {
  // Claude Code: the token on disk rotates while the request is in flight.
  const w = world();
  w.hold[USAGE] = deferred();
  w.hold[WHAM] = deferred();
  const first = boot(w);
  await first.start();
  w.ccToken = "rotated-token";
  w.account = "acct-B"; // the stored identity moves after the request began
  w.hold[USAGE].resolve(
    Response.json({
      five_hour: { utilization: 20, resets_at: "2026-01-01T15:00:00Z" },
    }),
  );
  w.hold[WHAM].resolve(
    Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18000,
          resets_at: (START + 4 * 3_600_000) / 1000,
        },
      },
    }),
  );
  delete w.hold[USAGE];
  delete w.hold[WHAM];
  await tick();
  await tick();
  assert.match(claude(first.env), /80% left/);
  assert.match(codex(first.env), /75% left/);
  // Back to the original identities: the old read must not have been kept.
  w.ccToken = "synthetic-claude-code-token";
  w.account = "acct-A";
  const second = await reload(w, first, 20_000);
  assert.doesNotMatch(claude(second.env), /80% left/);
  assert.doesNotMatch(codex(second.env), /75% left/);
});

test("a passive response that raced a read supersedes retained windows across reload", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  assert.match(claude(first.env), /80% left/);
  assert.match(claude(first.env), /65% left/);

  // A second read is in flight when a real response reports the 5h window.
  w.hold[USAGE] = deferred();
  w.hold[WHAM] = deferred();
  await first.advance(5 * MIN + 1_000);
  first.handlers.message_end({
    message: {
      role: "assistant",
      provider: "claude-code",
      diagnostics: [
        {
          type: "claude-code.rate-limit",
          timestamp: w.now,
          details: {
            unifiedWindows: {
              five_hour: { utilization: 50, resetsAt: 1767290000 },
            },
          },
        },
      ],
    },
  });
  w.hold[USAGE].resolve(
    Response.json({
      five_hour: { utilization: 20, resets_at: "2026-01-01T15:00:00Z" },
      seven_day: { utilization: 30, resets_at: "2026-01-05T00:00:00Z" },
    }),
  );
  w.hold[WHAM].resolve(
    Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 40,
          limit_window_seconds: 18000,
          resets_at: (START + 4 * 3_600_000) / 1000,
        },
      },
    }),
  );
  delete w.hold[USAGE];
  delete w.hold[WHAM];
  await tick();
  await tick();
  // Only the window that survived the race was accepted from the read.
  assert.match(claude(first.env), /70% left/);

  const second = await reload(w, first, 10_000);
  assert.equal(second.reads(USAGE), 0);
  const shown = claude(second.env);
  // The 5h window was superseded by a response of unproven identity: neither
  // the old read value nor the passive value is restored. 1w is the new read.
  assert.doesNotMatch(shown, /80% left/);
  assert.doesNotMatch(shown, /50% left/);
  assert.doesNotMatch(shown, /65% left/);
  assert.match(shown, /70% left/);
});

test("a passive Codex response is never restored from an older read", async () => {
  const w = world();
  const first = boot(w);
  await first.start();
  w.now += 1_000;
  first.env.now = w.now;
  assert.match(codex(first.env), /75% left/);
  first.handlers.after_provider_response(
    {
      status: 200,
      headers: {
        "x-codex-primary-used-percent": "60",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String((START + 4 * 3_600_000) / 1000),
      },
    },
    first.ctx,
  );
  assert.match(codex(first.env), /40% left/);
  const second = await reload(w, first, 10_000);
  assert.doesNotMatch(codex(second.env), /75% left/);
  assert.doesNotMatch(codex(second.env), /40% left/);
});

test("the runtime retains a passive update only with a proof that still matches", async () => {
  const { createRefreshRuntime } = loadRuntime({
    entry: "refresh-runtime",
  }).entry;
  const { defaultPreferences } = loadRuntime({ entry: "preferences" }).entry;
  const { store } = memory();
  let current = store.digest("codex", "acct-A");
  const runtime = createRefreshRuntime({
    scope: "s",
    owner: "o",
    preferences: () => defaultPreferences(),
    readers: {
      codex: () => new Promise(() => undefined),
      anthropic: () => new Promise(() => undefined),
    },
    antigravity: { poll: () => new Promise(() => undefined) },
    deliver() {},
    now: () => START,
    random: () => 0,
    host: {},
    memory: { store, context: { codex: async () => current } },
  });
  runtime.start();
  const passive = (percent) => ({
    providerId: "codex",
    availability: "ready",
    pools: [
      {
        id: "default",
        windows: [
          {
            kind: "5h",
            remainingPercent: percent,
            observedAt: new Date(START).toISOString(),
            source: "response-event",
            resetsAt: new Date(START + 3_600_000).toISOString(),
          },
        ],
      },
    ],
  });
  const recalled = () => store.recall("s", "codex", current, START + 1);

  runtime.observed("codex", passive(40), current);
  await tick();
  assert.equal(recalled()[0].windows[0].remainingPercent, 40);

  // Proof of another account: forgotten, never stored.
  runtime.observed("codex", passive(30), store.digest("codex", "acct-B"));
  await tick();
  assert.equal(recalled(), undefined);

  // No proof: the superseded window is dropped instead of kept stale.
  store.remember("s", "codex", current, passive(80).pools, START);
  runtime.observed("codex", passive(35));
  await tick();
  assert.equal(recalled(), undefined);

  // Proof that no longer matches the current identity is rejected.
  const proof = current;
  current = store.digest("codex", "acct-C");
  runtime.observed("codex", passive(20), proof);
  await tick();
  assert.equal(recalled(), undefined);
});

test("memory merges per window, replaces on another context and drops windows", () => {
  const { store } = memory();
  const a = store.digest("codex", "a");
  const at = (offset) => new Date(START + offset).toISOString();
  const one = (kind, percent, offset) => ({
    id: "default",
    windows: [
      {
        kind,
        remainingPercent: percent,
        observedAt: at(offset),
        source: "read-only-endpoint",
      },
    ],
  });
  store.merge("s", "codex", a, [one("5h", 50, 0)], START);
  store.merge("s", "codex", a, [one("1w", 60, 1000)], START + 1000);
  // An older observation never replaces a newer one.
  store.merge("s", "codex", a, [one("5h", 10, -5000)], START + 2000);
  let got = store.recall("s", "codex", a, START + 3000);
  const by = Object.fromEntries(
    got[0].windows.map((item) => [item.kind, item.remainingPercent]),
  );
  assert.deepEqual(by, { "5h": 50, "1w": 60 });

  store.drop("s", "codex", [{ pool: "default", kind: "5h" }]);
  got = store.recall("s", "codex", a, START + 3000);
  assert.equal(got[0].windows.map((item) => item.kind).join(), "1w");
  store.drop("s", "codex", [{ pool: "default", kind: "1w" }]);
  assert.equal(store.recall("s", "codex", a, START + 3000), undefined);

  // Another context replaces, and an unprovable one forgets.
  store.merge("s", "codex", a, [one("5h", 50, 0)], START);
  store.merge(
    "s",
    "codex",
    store.digest("codex", "b"),
    [one("1w", 5, 0)],
    START,
  );
  assert.equal(store.recall("s", "codex", a, START), undefined);
  store.merge("s", "codex", a, [one("5h", 50, 0)], START);
  store.merge("s", "codex", undefined, [one("5h", 50, 0)], START);
  assert.equal(store.recall("s", "codex", a, START), undefined);
});

test("the auth context is opaque, validated and only on success outcomes", () => {
  const { toPollOutcome } = loadRuntime({ entry: "poll-outcome" }).entry;
  const { store } = memory();
  const digest = store.digest("claude-code", "secret-token");
  const result = {
    providerId: "codex",
    availability: "ready",
    pools: pools(),
  };
  assert.equal(
    toPollOutcome("codex", result, { authContext: digest }).authContext,
    digest,
  );
  assert.equal(
    toPollOutcome("codex", result, { authContext: "raw-secret" }).authContext,
    undefined,
  );
  const failed = toPollOutcome(
    "codex",
    { providerId: "codex", availability: "error", pools: [] },
    { httpStatus: 500, authContext: digest },
  );
  assert.equal(failed.authContext, undefined);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(digest));
});

// ---- deterministic asynchronous retention races (held context promises) ----

const flush = async () => {
  for (let index = 0; index < 3; index++) await tick();
};

/** A runtime whose Codex context resolves only when the test releases `gate`. */
function rig({ store, gate, scope = "s", owner = "o", clock = { t: START } }) {
  const { createRefreshRuntime } = loadRuntime({
    entry: "refresh-runtime",
  }).entry;
  const { defaultPreferences } = loadRuntime({ entry: "preferences" }).entry;
  const reads = [];
  const runtime = createRefreshRuntime({
    scope,
    owner,
    preferences: () => defaultPreferences(),
    readers: {
      codex: () => new Promise((done) => reads.push(done)),
      anthropic: () => new Promise(() => undefined),
    },
    antigravity: { poll: () => new Promise(() => undefined) },
    deliver() {},
    now: () => clock.t,
    random: () => 0,
    host: {},
    memory: { store, context: { codex: () => gate.promise } },
  });
  runtime.start();
  runtime.tick();
  return { runtime, reads, clock };
}

const win = (kind, percent) => ({
  kind,
  remainingPercent: percent,
  observedAt: new Date(START).toISOString(),
  source: "read-only-endpoint",
  resetsAt: new Date(START + 3_600_000).toISOString(),
});
const result = (kind, percent, source) => ({
  providerId: "codex",
  availability: "ready",
  pools: [
    {
      id: "default",
      windows: [{ ...win(kind, percent), ...(source ? { source } : {}) }],
    },
  ],
});
const succeed = (kind, percent, authContext) => ({
  kind: "success",
  providerId: "codex",
  result: result(kind, percent),
  authContext,
});
const stored = (store, proof) => store.recall("s", "codex", proof, START + 1);

test("a passive update during the context await is not overwritten by older retention", async () => {
  const { store } = memory();
  const proof = store.digest("codex", "a");
  store.remember("s", "codex", proof, result("5h", 80).pools, START);
  const gate = deferred();
  const one = rig({ store, gate });
  one.reads[0](succeed("5h", 70, proof));
  await flush();
  // The retention of that read is waiting on the held context.
  one.runtime.observed("codex", result("5h", 40, "response-event"));
  assert.equal(stored(store, proof), undefined);
  gate.resolve(proof);
  await flush();
  // Neither the superseded 80 nor the older read's 70 came back.
  assert.equal(stored(store, proof), undefined);
});

test("an authentication forget invalidates retention that is still waiting", async () => {
  const { store } = memory();
  const proof = store.digest("codex", "a");
  const gate = deferred();
  const clock = { t: START };
  const one = rig({ store, gate, clock });
  one.reads[0](succeed("5h", 70, proof));
  await flush();
  clock.t += 30 * MIN;
  one.runtime.tick();
  one.reads[1]({
    kind: "failure",
    providerId: "codex",
    failure: "authentication",
    detail: "rejected",
  });
  await flush();
  gate.resolve(proof);
  await flush();
  assert.equal(stored(store, proof), undefined);
});

test("another runtime changing the shared entry makes pending retention stale", async () => {
  const { store } = memory();
  const proof = store.digest("codex", "a");
  const gate = deferred();
  const one = rig({ store, gate });
  one.reads[0](succeed("5h", 70, proof));
  await flush();
  store.forget("s", "codex");
  gate.resolve(proof);
  await flush();
  assert.equal(stored(store, proof), undefined);
});

test("a stopped controller cannot merge or forget in a newer runtime's memory", async () => {
  const { store } = memory();
  const proofA = store.digest("codex", "a");
  const proofB = store.digest("codex", "b");

  // Old runtime: retention pending on its held context, then it shuts down.
  const oldGate = deferred();
  const old = rig({ store, gate: oldGate, owner: "old" });
  old.reads[0](succeed("5h", 99, proofB));
  await flush();
  old.runtime.stop();

  // A new runtime (another session) retains its own, newer-identity data.
  const freshGate = deferred();
  freshGate.resolve(proofB);
  const fresh = rig({ store, gate: freshGate, owner: "new" });
  fresh.reads[0](succeed("5h", 60, proofB));
  await flush();
  assert.equal(stored(store, proofB)[0].windows[0].remainingPercent, 60);

  // The old merge would have replaced 60 with 99; the old delayed forget (a
  // context that disagrees with its proof) would have deleted the entry.
  oldGate.resolve(proofB);
  await flush();
  assert.equal(stored(store, proofB)[0].windows[0].remainingPercent, 60);

  const forgetGate = deferred();
  const older = rig({ store, gate: forgetGate, owner: "older" });
  older.reads[0](succeed("5h", 10, proofA));
  await flush();
  older.runtime.stop();
  forgetGate.resolve(proofB);
  await flush();
  assert.equal(stored(store, proofB)[0].windows[0].remainingPercent, 60);
});

test("an unproven passive drop in a second runtime stops retention waiting on an empty cache", async () => {
  const { store } = memory();
  const proof = store.digest("codex", "a");
  // Nothing is retained yet: the drop below has no entry to remove.
  assert.equal(stored(store, proof), undefined);

  const gate = deferred();
  const first = rig({ store, gate, owner: "first" });
  first.reads[0](succeed("5h", 70, proof));
  await flush();

  const otherGate = deferred();
  otherGate.resolve(proof);
  const second = rig({ store, gate: otherGate, owner: "second" });
  second.runtime.observed("codex", result("5h", 40, "response-event"));
  await flush();

  gate.resolve(proof);
  await flush();
  assert.equal(stored(store, proof), undefined);
});

test("memory versions change on every mutation and rise after pruning", () => {
  const { store } = memory();
  const ctx = store.digest("codex", "a");
  const seen = [store.version("s", "codex")];
  const step = (action) => {
    action();
    const next = store.version("s", "codex");
    assert.notEqual(next, seen.at(-1));
    seen.push(next);
  };
  step(() => store.remember("s", "codex", ctx, pools(), START));
  step(() => store.merge("s", "codex", ctx, pools(), START));
  step(() => store.drop("s", "codex", [{ pool: "default", kind: "w0" }]));
  step(() => store.forget("s", "codex"));
  // An unrelated entry is untouched by another key's change.
  const other = store.version("s", "claude-code");
  store.remember("s", "codex", ctx, pools(), START);
  assert.equal(store.version("s", "claude-code"), other);
  // Eviction of another key counts as a change to that key.
  store.remember("old", "codex", ctx, pools(), START - 1);
  const before = store.version("old", "codex");
  for (let index = 0; index < 16; index++)
    store.remember(`n${index}`, "codex", ctx, pools(), START + index);
  assert.notEqual(store.version("old", "codex"), before);
  // Pruned version records never read lower than an earlier observation.
  const early = store.version("n0", "codex");
  for (let index = 0; index < 80; index++)
    store.remember(`p${index}`, "codex", ctx, pools(), START + 100 + index);
  assert.ok(store.version("n0", "codex") > early);
});
