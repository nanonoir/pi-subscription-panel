import type { AntigravityPoll } from "./antigravity-cli.ts";
import {
  POLL_FAILURE,
  POLL_OUTCOME,
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
  type QuotaResult,
} from "./quota-contracts.ts";
import {
  DEFAULT_GAPS,
  RETRY_STATUS,
  createRefreshScheduler,
  type PollJob,
  type ProviderSchedule,
  type RefreshScheduler,
  type RetryResult,
} from "./refresh-scheduler.ts";

// Composes the tested scheduler with the provider transports, preferences and
// result delivery. It owns no I/O of its own: readers, the Antigravity poller,
// clock and randomness are injected. Claude Code is never a job.

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
  >;
  antigravity: {
    poll: (options: { signal: AbortSignal }) => Promise<AntigravityPoll>;
  };
  /** Receives presentation results for live attempts only. */
  deliver: (result: QuotaResult) => void;
  now: () => number;
  random: () => number;
  host?: object;
}

export interface RefreshRuntime {
  /** Creates the scheduler from loaded preferences; nothing starts yet. */
  start: () => void;
  /** Starts only the jobs that are eligible; never called by UI actions. */
  tick: () => void;
  /** A passive provider response: defers polling and drops older in-flight data. */
  observed: (providerId: ProviderId) => void;
  /** An ordinary relevant provider turn/response, never a UI repaint. */
  noteActivity: (providerId: ProviderId) => void;
  /** Explicit user retry; the only UI path that can cause a read. */
  retry: (providerId: ProviderId) => RetryResult | undefined;
  /** Cancels in-flight jobs that are no longer enabled; never starts any. */
  preferencesChanged: () => void;
  /** Aborts local jobs; exclusion remains until each settles. */
  stop: () => void;
}

const POLLING: readonly PollingProviderId[] = [
  PROVIDER.CODEX,
  PROVIDER.ANTHROPIC,
  PROVIDER.ANTIGRAVITY,
];

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
  const pendingActivity = new Set<PollingProviderId>();

  const revision = (id: PollingProviderId): number => revisions.get(id) ?? 0;

  function enabled(id: PollingProviderId): boolean {
    if (stopped) return false;
    const preferences = options.preferences();
    if (
      id === PROVIDER.ANTIGRAVITY &&
      preferences.refresh.antigravity.mode !== ANTIGRAVITY_MODE.AUTO
    )
      return false;
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
  function surfaceBlock(id: PollingProviderId, lastError?: string): void {
    options.deliver({
      providerId: id,
      availability: AVAILABILITY.ERROR,
      pools: [],
      detail: `${lastError ?? "Quota read failed; manual retry required."} · manual retry: /subscriptions retry ${id}`,
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
      const { blocked, lastError } = scheduler.schedule(id) ?? {};
      if (
        blocked === undefined ||
        (id === PROVIDER.ANTIGRAVITY &&
          options.preferences().refresh.antigravity.mode !==
            ANTIGRAVITY_MODE.AUTO)
      ) {
        shownBlocks.delete(id);
        continue;
      }
      if (shownBlocks.has(id)) continue;
      shownBlocks.add(id);
      surfaceBlock(id, lastError);
    }
  }

  function publish(outcome: PollOutcome, schedule: ProviderSchedule): void {
    const id = outcome.providerId;
    if (stopped || outcome.kind === POLL_OUTCOME.CANCELLED) return;
    if (schedule.blocked) shownBlocks.add(id);
    else shownBlocks.delete(id);
    // A passive response arrived after this attempt started: it is newer. Its
    // data wins, but a resulting block must stay visible; the error carries no
    // windows, so the existing quota is merged untouched.
    if (attemptRevision.get(id) !== revision(id)) {
      if (outcome.kind === POLL_OUTCOME.FAILURE && schedule.blocked) {
        surfaceBlock(id, schedule.lastError);
      }
      return;
    }
    if (outcome.kind === POLL_OUTCOME.SUCCESS) {
      options.deliver(outcome.result);
      return;
    }
    const hint = schedule.blocked
      ? ` · manual retry: /subscriptions retry ${id}`
      : "";
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
    },

    tick() {
      if (!scheduler) return;
      scheduler.tick();
      syncBlocks();
    },

    observed(providerId) {
      if (stopped || !isPolling(providerId)) return;
      if (providerId === PROVIDER.ANTIGRAVITY) return;
      revisions.set(providerId, revision(providerId) + 1);
      deferUntil.set(providerId, options.now() + passiveGapMs(providerId));
      this.noteActivity(providerId);
      // The caller has just applied the passive result, which replaced the
      // panel's error state; a retained block keeps its guidance next to the
      // valid windows. No read is made.
      const { blocked, lastError } = scheduler?.schedule(providerId) ?? {};
      if (blocked !== undefined) {
        shownBlocks.add(providerId);
        surfaceBlock(providerId, lastError);
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
      // Re-enabling Antigravity over a retained block shows it again, once.
      syncBlocks();
    },

    stop() {
      stopped = true;
      scheduler?.stop();
    },
  };
}
