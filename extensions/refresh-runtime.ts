import type { AntigravityPoll } from "./antigravity-cli.ts";
import {
  POLL_FAILURE,
  POLL_OUTCOME,
  describeFailure,
  toPollOutcome,
  type PollOutcome,
  type PollingProviderId,
} from "./poll-outcome.ts";
import {
  ANTIGRAVITY_MODE,
  type SubscriptionPreferences,
} from "./preferences.ts";
import {
  AVAILABILITY,
  PROVIDER,
  type ProviderId,
  type QuotaPool,
  type QuotaResult,
} from "./quota-contracts.ts";
import type { QuotaMemory } from "./quota-memory.ts";
import {
  DEFAULT_GAPS,
  DEFERRAL,
  RETRY_STATUS,
  createRefreshScheduler,
  type DeferralCause,
  type PollJob,
  type ProviderSchedule,
  type RefreshScheduler,
  type RetryResult,
} from "./refresh-scheduler.ts";

// Composes the tested scheduler with the provider transports, preferences and
// result delivery. It owns no I/O of its own: readers, the Antigravity poller,
// clock and randomness are injected. Claude Code is a job only when its
// optional reader is supplied.

export type PollReader = (signal: AbortSignal) => Promise<PollOutcome>;

export interface RefreshRuntimeOptions {
  /** Agent-directory scope shared by controllers of this Pi process. */
  scope: string;
  /** Distinct per live extension instance; no cross-session identifiers. */
  owner: string;
  preferences: () => SubscriptionPreferences;
  readers: Record<
    typeof PROVIDER.CODEX | typeof PROVIDER.ANTHROPIC,
    PollReader
  > & { [PROVIDER.CLAUDE_CODE]?: PollReader };
  antigravity: {
    poll: (options: { signal: AbortSignal }) => Promise<AntigravityPoll>;
  };
  /** Receives presentation results for live attempts only. */
  deliver: (result: QuotaResult) => void;
  now: () => number;
  random: () => number;
  host?: object;
  /**
   * Optional in-memory retention across reload. Only providers with a context
   * function are retained; it returns an opaque digest of the current
   * authentication context (never a credential), or undefined when that cannot
   * be proven. It must not make requests or renew tokens. A read is retained
   * only when its outcome's `authContext` (the credential the request actually
   * used) equals this current context after the request; restore uses it alone.
   * Antigravity's context is the owner-approved single-account-per-process
   * marker, not a verified identity.
   */
  memory?: {
    store: QuotaMemory;
    context: Partial<
      Record<PollingProviderId, () => Promise<string | undefined>>
    >;
  };
}

export interface RefreshRuntime {
  /** Creates the scheduler from loaded preferences; nothing starts yet. */
  start: () => void;
  /** Starts only the jobs that are eligible; never called by UI actions. */
  tick: () => void;
  /** A passive provider response: defers polling and drops older in-flight data. */
  observed: (
    providerId: ProviderId,
    passive?: QuotaResult,
    /** Opaque digest proving which credential the passive response used. */
    authContext?: string,
  ) => void;
  /** An ordinary relevant provider turn/response, never a UI repaint. */
  noteActivity: (providerId: ProviderId) => void;
  /** Explicit user retry; the only UI path that can cause a read. */
  retry: (providerId: ProviderId) => RetryResult | undefined;
  /** Cancels in-flight jobs that are no longer enabled; never starts any. */
  preferencesChanged: () => void;
  /**
   * Read-only scheduling metadata per provider for diagnostics. Reads the
   * registry only: no request, credential access or persistence. Undefined
   * before `start`.
   */
  status: () => ProviderStatus[] | undefined;
  /** Aborts local jobs; exclusion remains until each settles. */
  stop: () => void;
}

export interface ProviderStatus {
  id: ProviderId;
  /** Whether automatic polling is currently allowed by preferences. */
  enabled: boolean;
  schedule: ProviderSchedule;
}

const POLLING: readonly PollingProviderId[] = [
  PROVIDER.CODEX,
  PROVIDER.CLAUDE_CODE,
  PROVIDER.ANTHROPIC,
  PROVIDER.ANTIGRAVITY,
];

const retryHint = (id: PollingProviderId): string =>
  ` · manual retry: /subscriptions retry ${id}`;

const DEFERRAL_TEXT: Record<DeferralCause, string> = {
  [DEFERRAL.SERVER]: "server deadline",
  [DEFERRAL.BACKOFF]: "failure backoff",
  [DEFERRAL.GAP]: "minimum refresh gap",
};

/** Legacy records may carry a failure count or error without `lastFailure`. */
const hasFailureHistory = (schedule: ProviderSchedule): boolean =>
  schedule.lastFailure !== undefined ||
  schedule.failureCount > 0 ||
  schedule.lastError !== undefined;

/** Retained reason, or an explicit unknown for records that predate it. */
const failureText = (schedule: ProviderSchedule): string =>
  schedule.lastFailure
    ? describeFailure(schedule.lastFailure)
    : "reason unknown";

/** Truthful, fixed-vocabulary reason a read is not yet due after a reload. */
function deferredDetail(schedule: ProviderSchedule): string {
  const cause = schedule.deferral?.cause ?? DEFERRAL.GAP;
  if (hasFailureHistory(schedule)) {
    return `Last read failed: ${failureText(schedule)} · waiting on ${DEFERRAL_TEXT[cause]}`;
  }
  return cause === DEFERRAL.GAP
    ? "Next read deferred by the minimum refresh gap"
    : `Last read result unknown · waiting on ${DEFERRAL_TEXT[cause]}`;
}

const isPolling = (id: ProviderId): id is PollingProviderId =>
  (POLLING as readonly string[]).includes(id);

export function createRefreshRuntime(
  options: RefreshRuntimeOptions,
): RefreshRuntime {
  let scheduler: RefreshScheduler | undefined;
  let stopped = false;
  const shownBlocks = new Set<PollingProviderId>();
  const revisions = new Map<PollingProviderId, number>();
  const attemptRevision = new Map<PollingProviderId, number>();
  const deferUntil = new Map<PollingProviderId, number>();
  // Newest valid observation time (ms) per window (pool + kind) a passive
  // response supplied since the attempt began; `undefined` means the passive
  // content is unknown, so the whole read is stale.
  const passiveWindows = new Map<
    PollingProviderId,
    Map<string, number> | undefined
  >();
  // Read observedAt is stamped at completion, so the attempt start is the
  // conservative snapshot boundary a passive observation is compared against.
  const attemptStart = new Map<PollingProviderId, number>();
  const windowKey = (pool: string, kind: string): string => `${pool}\0${kind}`;
  const pendingActivity = new Set<PollingProviderId>();
  // Deadline last shown by the empty "deferred" panel state; cleared once any
  // observation or result replaces that state.
  const shownDeferred = new Map<PollingProviderId, string>();
  // Retention updates run in order per provider: each one re-derives the
  // current context after the request it belongs to.
  const retention = new Map<PollingProviderId, Promise<void>>();
  // Local mutation counter per provider. Anything that changes what memory may
  // hold (a passive supersede, an authentication forget, stop) advances it, so
  // asynchronous retention started earlier can tell it is stale.
  const mutations = new Map<PollingProviderId, number>();
  const mutation = (id: PollingProviderId): number => mutations.get(id) ?? 0;
  const mutated = (id: PollingProviderId): void => {
    mutations.set(id, mutation(id) + 1);
  };
  // Providers that already received an observation or result: restoring older
  // retained data afterwards would hide it.
  const answered = new Set<PollingProviderId>();

  /** Never throws: an unprovable context is simply undefined. */
  const contextOf = (
    id: PollingProviderId,
  ): Promise<string | undefined> | undefined => {
    const read = options.memory?.context[id];
    return read ? read().catch(() => undefined) : undefined;
  };

  const revision = (id: PollingProviderId): number => revisions.get(id) ?? 0;

  /**
   * Retains windows that were actually accepted and shown. They are bound to the
   * context of the credential the request really used (`proof`), and kept only
   * while the current non-renewing identity still equals it; otherwise (unknown
   * or changed, e.g. mid-request) the entry is forgotten. Every mutation happens
   * synchronously after the context await and only if nothing changed meanwhile:
   * this runtime was not stopped, no local mutation intervened and no runtime
   * (including a newer one) touched the shared entry. Never throws.
   */
  function retain(
    id: PollingProviderId,
    pools: readonly QuotaPool[],
    proof: string | undefined,
  ): void {
    const memory = options.memory;
    if (stopped || !memory?.context[id]) return;
    const local = mutation(id);
    const task = (retention.get(id) ?? Promise.resolve()).then(async () => {
      if (stopped || mutation(id) !== local) return;
      // A read that finishes after Antigravity was disabled is never kept.
      if (id === PROVIDER.ANTIGRAVITY && antigravityOff()) return;
      const seen = memory.store.version(options.scope, id);
      const current = await contextOf(id);
      if (
        stopped ||
        mutation(id) !== local ||
        memory.store.version(options.scope, id) !== seen
      )
        return;
      if (proof === undefined || current !== proof)
        memory.store.forget(options.scope, id);
      else memory.store.merge(options.scope, id, proof, pools, options.now());
    });
    retention.set(
      id,
      task.catch(() => undefined),
    );
  }

  /**
   * Forgets windows a response of unproven identity has just superseded. It is
   * synchronous (outside the retention queue) and invalidates pending retention.
   */
  function supersede(
    id: PollingProviderId,
    windows?: readonly { pool: string; kind: string }[],
  ): void {
    const memory = options.memory;
    if (!memory?.context[id]) return;
    mutated(id);
    if (windows === undefined) memory.store.forget(options.scope, id);
    else memory.store.drop(options.scope, id, windows);
  }

  const antigravityOff = (): boolean =>
    options.preferences().refresh.antigravity.mode !== ANTIGRAVITY_MODE.AUTO;

  /** Opting out of Antigravity discards whatever memory holds for it. */
  function forgetIfAntigravityOff(): void {
    if (antigravityOff()) supersede(PROVIDER.ANTIGRAVITY);
  }

  function enabled(id: PollingProviderId): boolean {
    if (stopped) return false;
    const preferences = options.preferences();
    if (id === PROVIDER.ANTIGRAVITY && antigravityOff()) return false;
    // Collapsed refresh is a separate policy; it never changes backoff state.
    if (
      !preferences.refresh.whileCollapsed &&
      !preferences.expandedProviders.includes(id)
    )
      return false;
    return options.now() >= (deferUntil.get(id) ?? 0);
  }

  function job(id: PollingProviderId, run: PollReader): PollJob {
    return {
      providerId: id,
      enabled: () => enabled(id),
      run: (signal) => {
        attemptRevision.set(id, revision(id));
        passiveWindows.set(id, new Map());
        attemptStart.set(id, options.now());
        return run(signal);
      },
    };
  }

  const antigravityJob = job(PROVIDER.ANTIGRAVITY, async (signal) => {
    try {
      const poll = await options.antigravity.poll({ signal });
      // Exclusion lasts until the owned child is confirmed ended.
      await poll.settled;
      return toPollOutcome(PROVIDER.ANTIGRAVITY, poll.result, poll.meta);
    } catch {
      // Indeterminate CLI failure: pause automation until manual retry.
      return {
        kind: POLL_OUTCOME.FAILURE,
        providerId: PROVIDER.ANTIGRAVITY,
        failure: POLL_FAILURE.MANUAL,
        detail: "Quota refresh failed",
      };
    }
  });

  /** Fixed sanitized block text with retry guidance; never reads or restores quota. */
  function surfaceBlock(
    id: PollingProviderId,
    schedule: ProviderSchedule,
  ): void {
    options.deliver({
      providerId: id,
      availability: AVAILABILITY.ERROR,
      pools: [],
      // Short on purpose: the panel truncates detail, and retry guidance must
      // stay visible after the reason.
      detail: `Last read failed: ${failureText(schedule)}${retryHint(id)}`,
    });
  }

  /**
   * Shows a block the registry holds that this runtime has not shown yet, e.g.
   * a late authentication failure from a replaced controller. Reads the
   * schedule only: it never starts a read and restores no quota.
   */
  function syncBlocks(): void {
    if (stopped || !scheduler) return;
    for (const id of POLLING) {
      const schedule = scheduler.schedule(id);
      if (
        schedule?.blocked === undefined ||
        (id === PROVIDER.ANTIGRAVITY &&
          options.preferences().refresh.antigravity.mode !==
            ANTIGRAVITY_MODE.AUTO)
      ) {
        shownBlocks.delete(id);
        continue;
      }
      if (shownBlocks.has(id)) continue;
      shownBlocks.add(id);
      surfaceBlock(id, schedule);
    }
  }

  /**
   * After a reload the panel is empty while the process registry keeps the rate
   * gap. Tell the panel when the next read may start; no quota is restored and
   * no read is made. An observation or result that arrives later replaces it.
   */
  function surfaceDeferred(resync = false, only?: PollingProviderId): void {
    if (stopped || !scheduler) return;
    const now = options.now();
    for (const id of POLLING) {
      if (only !== undefined && id !== only) continue;
      if (resync && !shownDeferred.has(id)) continue;
      if (revision(id) > 0) continue;
      if (!resync && !enabled(id)) continue;
      const schedule = scheduler.schedule(id);
      if (!schedule || schedule.blocked !== undefined) continue;
      const detail = deferredDetail(schedule);
      const shown = `${schedule.nextEligibleMs}|${detail}`;
      if (schedule.nextEligibleMs > now && shownDeferred.get(id) !== shown) {
        shownDeferred.set(id, shown);
        options.deliver({
          providerId: id,
          availability: hasFailureHistory(schedule)
            ? AVAILABILITY.ERROR
            : AVAILABILITY.WAITING,
          pools: [],
          detail,
          retryAt: new Date(schedule.nextEligibleMs).toISOString(),
        });
      }
    }
  }

  /**
   * After a reload, shows the retained last observations with their original
   * observation times and sources. It makes no read and never alters a
   * deadline; an eligible read still starts on the first tick and replaces it.
   * Skipped when the context cannot be proven the same, when the provider is
   * off, blocked or already answered, and after stop.
   */
  async function restore(id: PollingProviderId): Promise<void> {
    const memory = options.memory;
    const context = contextOf(id);
    if (!memory || !context || !enabled(id)) return;
    const local = mutation(id);
    const seen = memory.store.version(options.scope, id);
    const proven = await context;
    if (
      stopped ||
      !scheduler ||
      revision(id) > 0 ||
      answered.has(id) ||
      !enabled(id) ||
      mutation(id) !== local ||
      memory.store.version(options.scope, id) !== seen
    )
      return;
    const schedule = scheduler.schedule(id);
    if (!schedule || schedule.blocked !== undefined) {
      mutated(id);
      memory.store.forget(options.scope, id);
      return;
    }
    const pools = memory.store.recall(options.scope, id, proven, options.now());
    if (!pools) return;
    shownDeferred.delete(id);
    options.deliver({
      providerId: id,
      availability: AVAILABILITY.READY,
      pools,
    });
    // A retained failure stays visible over the older windows.
    if (hasFailureHistory(schedule)) surfaceDeferred(false, id);
  }

  function publish(outcome: PollOutcome, schedule: ProviderSchedule): void {
    const id = outcome.providerId;
    if (stopped || outcome.kind === POLL_OUTCOME.CANCELLED) return;
    answered.add(id);
    shownDeferred.delete(id);
    const memory = options.memory;
    // A failure never stores anything; only authentication loss forgets.
    if (
      memory?.context[id] &&
      outcome.kind === POLL_OUTCOME.FAILURE &&
      outcome.failure === POLL_FAILURE.AUTHENTICATION
    ) {
      mutated(id);
      memory.store.forget(options.scope, id);
    }
    if (schedule.blocked) shownBlocks.add(id);
    else shownBlocks.delete(id);
    // A passive response arrived after this attempt started: it is newer. Its
    // data wins, but a resulting block must stay visible; the error carries no
    // windows, so the existing quota is merged untouched.
    if (attemptRevision.get(id) !== revision(id)) {
      if (outcome.kind === POLL_OUTCOME.FAILURE && schedule.blocked) {
        surfaceBlock(id, schedule);
      }
      // A window is superseded when a passive response observed it at or after
      // the attempt start (the read may predate it, whatever its completion
      // stamp says). Older passive diagnostics never suppress the read. Kept
      // windows retain their own actual observation times; invalid passive
      // timestamps are never tracked.
      const superseded = passiveWindows.get(id);
      const startedAt = attemptStart.get(id) ?? Number.NEGATIVE_INFINITY;
      if (outcome.kind === POLL_OUTCOME.SUCCESS && superseded) {
        const pools = outcome.result.pools
          .map((pool) => ({
            ...pool,
            windows: pool.windows.filter((window) => {
              const passiveAt = superseded.get(windowKey(pool.id, window.kind));
              return passiveAt === undefined || passiveAt < startedAt;
            }),
          }))
          .filter((pool) => pool.windows.length > 0);
        if (pools.length > 0) {
          options.deliver({ ...outcome.result, pools });
          // Only the windows that survived the race are retained.
          retain(id, pools, outcome.authContext);
        }
      }
      return;
    }
    if (outcome.kind === POLL_OUTCOME.SUCCESS) {
      options.deliver(outcome.result);
      retain(id, outcome.result.pools, outcome.authContext);
      return;
    }
    const hint = schedule.blocked ? retryHint(id) : "";
    const retryAt =
      outcome.retryAtMs !== undefined &&
      Number.isFinite(new Date(outcome.retryAtMs).getTime())
        ? new Date(outcome.retryAtMs).toISOString()
        : undefined;
    options.deliver({
      providerId: id,
      availability: AVAILABILITY.ERROR,
      pools: [],
      detail: `${outcome.detail}${hint}`,
      ...(retryAt ? { retryAt } : {}),
    });
  }

  function passiveGapMs(id: PollingProviderId): number {
    return id === PROVIDER.CODEX
      ? options.preferences().refresh.codexSeconds * 1000
      : DEFAULT_GAPS[id].idleMs;
  }

  return {
    start() {
      if (stopped || scheduler) return;
      const { refresh } = options.preferences();
      const claudeCodeReader = options.readers[PROVIDER.CLAUDE_CODE];
      scheduler = createRefreshScheduler({
        scope: options.scope,
        owner: options.owner,
        now: options.now,
        random: options.random,
        ...(options.host ? { host: options.host } : {}),
        gaps: {
          [PROVIDER.CODEX]: {
            activeMs: refresh.codexSeconds * 1000,
            idleMs: refresh.codexSeconds * 1000,
          },
          [PROVIDER.ANTIGRAVITY]: {
            activeMs: refresh.antigravity.activeSeconds * 1000,
            idleMs: refresh.antigravity.idleSeconds * 1000,
          },
        },
        jobs: [
          job(PROVIDER.CODEX, options.readers[PROVIDER.CODEX]),
          ...(claudeCodeReader
            ? [job(PROVIDER.CLAUDE_CODE, claudeCodeReader)]
            : []),
          job(PROVIDER.ANTHROPIC, options.readers[PROVIDER.ANTHROPIC]),
          antigravityJob,
        ],
        deliver: publish,
      });
      for (const id of pendingActivity) scheduler.noteActivity(id);
      pendingActivity.clear();
      // A block kept by the process registry survives reload: surface it with
      // fixed sanitized text and retry guidance. No quota is restored or read.
      syncBlocks();
      surfaceDeferred();
      forgetIfAntigravityOff();
      for (const id of POLLING) void restore(id);
    },

    tick() {
      if (!scheduler) return;
      scheduler.tick();
      syncBlocks();
      // A block takes priority; otherwise keep the empty waiting deadline true.
      surfaceDeferred(true);
    },

    observed(providerId, passive, authContext) {
      if (stopped || !isPolling(providerId)) return;
      if (providerId === PROVIDER.ANTIGRAVITY) return;
      answered.add(providerId);
      // A passive response is retained only with a proof of identity that still
      // matches; otherwise it supersedes (drops) what it replaced in memory.
      if (passive && authContext !== undefined) {
        // Newer than anything pending: older retention must not land after it.
        mutated(providerId);
        retain(providerId, passive.pools, authContext);
      } else
        supersede(
          providerId,
          passive?.pools.flatMap((pool) =>
            pool.windows.map((window) => ({
              pool: pool.id,
              kind: window.kind,
            })),
          ),
        );
      revisions.set(providerId, revision(providerId) + 1);
      shownDeferred.delete(providerId);
      if (!passive) passiveWindows.set(providerId, undefined);
      else {
        const seen = passiveWindows.get(providerId);
        if (passiveWindows.has(providerId) && seen === undefined) {
          // Already fully superseded by an opaque passive response.
        } else {
          const times = seen ?? new Map<string, number>();
          for (const pool of passive.pools)
            for (const window of pool.windows) {
              const at = Date.parse(window.observedAt);
              const key = windowKey(pool.id, window.kind);
              if (Number.isFinite(at) && at > (times.get(key) ?? -Infinity))
                times.set(key, at);
            }
          passiveWindows.set(providerId, times);
        }
      }
      deferUntil.set(providerId, options.now() + passiveGapMs(providerId));
      this.noteActivity(providerId);
      // The caller has just applied the passive result, which replaced the
      // panel's error state; a retained block keeps its guidance next to the
      // valid windows. No read is made.
      const schedule = scheduler?.schedule(providerId);
      if (schedule?.blocked !== undefined) {
        shownBlocks.add(providerId);
        surfaceBlock(providerId, schedule);
      }
    },

    noteActivity(providerId) {
      if (stopped || !isPolling(providerId)) return;
      if (scheduler) scheduler.noteActivity(providerId);
      else pendingActivity.add(providerId);
    },

    retry(providerId) {
      if (!isPolling(providerId)) return { status: RETRY_STATUS.UNKNOWN };
      if (!scheduler) return undefined;
      // An explicit request overrides passive deferral, never gaps or blocks.
      deferUntil.delete(providerId);
      return scheduler.retry(providerId);
    },

    preferencesChanged() {
      if (!scheduler) return;
      for (const id of POLLING) if (!enabled(id)) scheduler.cancel(id);
      forgetIfAntigravityOff();
      // Re-enabling Antigravity over a retained block shows it again, once.
      syncBlocks();
    },

    status() {
      const current = scheduler;
      if (stopped || !current) return undefined;
      return POLLING.flatMap((id) => {
        const schedule = current.schedule(id);
        return schedule ? [{ id, enabled: enabled(id), schedule }] : [];
      });
    },

    stop() {
      stopped = true;
      // Pending retention and restore of this controller must never mutate memory.
      for (const id of POLLING) mutated(id);
      scheduler?.stop();
    },
  };
}
