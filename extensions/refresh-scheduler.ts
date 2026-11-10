import {
  POLL_FAILURE,
  POLL_OUTCOME,
  toPollOutcome,
  type PollFailureKind,
  type PollOutcome,
  type PollingProviderId,
} from "./poll-outcome.ts";
import { PROVIDER } from "./quota-contracts.ts";

// Refresh scheduling engine. It decides when a polling job may start and
// records only scheduling metadata; it never reads quota, credentials or UI
// state. Time and randomness are injected, and all I/O lives in the jobs.

export const ACTIVITY_WINDOW_MS = 10 * 60_000;
export const DEFAULT_WAITER_TTL_MS = 2 * 60_000;

export interface PollGaps {
  activeMs: number;
  idleMs: number;
}

/** Minimum gaps between attempt starts. Antigravity stays opt-in elsewhere. */
export const DEFAULT_GAPS: Record<PollingProviderId, PollGaps> = {
  [PROVIDER.CODEX]: { activeMs: 60_000, idleMs: 60_000 },
  [PROVIDER.ANTHROPIC]: { activeMs: 30 * 60_000, idleMs: 30 * 60_000 },
  [PROVIDER.ANTIGRAVITY]: { activeMs: 3 * 60_000, idleMs: 20 * 60_000 },
};

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** Upper bound of the nonnegative random addition. */
  jitterMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 60_000,
  maxMs: 30 * 60_000,
  jitterMs: 15_000,
};

export interface PollJob {
  providerId: PollingProviderId;
  /** Evaluated on every decision; false never starts and cancels in-flight. */
  enabled: () => boolean;
  /** Must settle; should honor `signal` by cancelling its transport. */
  run: (signal: AbortSignal) => Promise<PollOutcome>;
}

/** Scheduling metadata only: no quota values, credentials or accounts. */
export interface ProviderSchedule {
  lastAttemptMs?: number;
  lastSuccessMs?: number;
  /** Earliest start given gaps, server deadline and backoff (blocks aside). */
  nextEligibleMs: number;
  inFlight: boolean;
  failureCount: number;
  lastError?: string;
  /** Automatic polling is stopped until an explicit retry. */
  blocked?: typeof POLL_FAILURE.AUTHENTICATION | typeof POLL_FAILURE.MANUAL;
  recentlyActive: boolean;
}

export const RETRY_STATUS = {
  STARTED: "started",
  DEFERRED: "deferred",
  IN_FLIGHT: "in-flight",
  DISABLED: "disabled",
  STOPPED: "stopped",
  UNKNOWN: "unknown",
} as const;

export type RetryStatus = (typeof RETRY_STATUS)[keyof typeof RETRY_STATUS];

export interface RetryResult {
  status: RetryStatus;
  /** Present when deferred: when the request may start. */
  eligibleAtMs?: number;
}

export interface RefreshSchedulerOptions {
  /** Agent-directory scope; metadata is shared per scope and provider. */
  scope: string;
  jobs: readonly PollJob[];
  now: () => number;
  /** Returns a value in [0, 1). */
  random: () => number;
  /** Called only for live, non-cancelled attempts of a live controller. */
  deliver: (
    outcome: PollOutcome,
    schedule: ProviderSchedule,
  ) => void | Promise<void>;
  gaps?: Partial<Record<PollingProviderId, PollGaps>>;
  backoff?: BackoffPolicy;
  /** Process registry host; defaults to the shared global realm. */
  host?: object;
  /**
   * Logical session key. Creating a controller with the same owner in a scope
   * invalidates the previous one (reload); other owners are unaffected.
   */
  owner?: string;
  /** A waiter that has not ticked for this long loses its queue turn. */
  waiterTtlMs?: number;
}

export interface RefreshScheduler {
  /** Starts every eligible job; returns the providers started. */
  tick: () => PollingProviderId[];
  /** Records relevant provider activity, switching to the active gap. */
  noteActivity: (providerId: PollingProviderId) => void;
  /** Explicit retry: clears a block, still honoring gaps and deadlines. */
  retry: (providerId: PollingProviderId) => RetryResult;
  /** Aborts an in-flight attempt; its result is dropped on settlement. */
  cancel: (providerId: PollingProviderId) => void;
  schedule: (providerId: PollingProviderId) => ProviderSchedule | undefined;
  /** Aborts attempts and stops delivery; exclusion persists until settle. */
  stop: () => void;
}

interface ProviderMeta {
  lastAttemptMs?: number;
  lastSuccessMs?: number;
  lastActivityMs?: number;
  serverRetryAtMs?: number;
  backoffUntilMs?: number;
  failureCount: number;
  lastError?: string;
  blocked?: ProviderSchedule["blocked"];
  /** Id of the attempt that holds exclusion. */
  inFlight?: number;
  /** FIFO of controllers waiting for the next start; ids only. */
  waiters: Waiter[];
}

interface Waiter {
  id: number;
  seenMs: number;
  owner?: string;
}

interface ScopeMeta {
  providers: Map<PollingProviderId, ProviderMeta>;
  /** Owner key to its current generation: primitives only. */
  owners: Map<string, number>;
}

interface ProcessRegistry {
  version: 1;
  attempts: number;
  scopes: Map<string, ScopeMeta>;
}

const REGISTRY_KEY = Symbol.for("pi-subscription-panel.refresh-registry.v1");

function isRegistry(value: unknown): value is ProcessRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ProcessRegistry).version === 1 &&
    (value as ProcessRegistry).scopes instanceof Map
  );
}

/** Versioned registry shared by every module instance in this realm. */
export function getProcessRegistry(host: object = globalThis): ProcessRegistry {
  const slots = host as Record<symbol, unknown>;
  const existing = slots[REGISTRY_KEY];
  if (isRegistry(existing)) return existing;
  const created: ProcessRegistry = {
    version: 1,
    attempts: 0,
    scopes: new Map(),
  };
  slots[REGISTRY_KEY] = created;
  return created;
}

const OUTCOME_KINDS: readonly string[] = Object.values(POLL_OUTCOME);
const FAILURE_KINDS: readonly string[] = Object.values(POLL_FAILURE);

/** Registry-safe errors: fixed text per failure class, never provider detail. */
const REGISTRY_ERROR: Record<PollFailureKind, string> = {
  [POLL_FAILURE.AUTHENTICATION]: "Authentication unavailable or rejected.",
  [POLL_FAILURE.RATE_LIMIT]: "Quota read was rate limited.",
  [POLL_FAILURE.RECOVERABLE]: "Quota read failed.",
  [POLL_FAILURE.MANUAL]: "Quota read failed; manual retry required.",
};

function recoverableFailure(providerId: PollingProviderId): PollOutcome {
  return {
    kind: POLL_OUTCOME.FAILURE,
    providerId,
    failure: POLL_FAILURE.RECOVERABLE,
    detail: "Quota read failed.",
  };
}

export function createRefreshScheduler(
  options: RefreshSchedulerOptions,
): RefreshScheduler {
  const registry = getProcessRegistry(options.host);
  let scopeMeta = registry.scopes.get(options.scope);
  if (scopeMeta === undefined) {
    scopeMeta = { providers: new Map(), owners: new Map() };
    registry.scopes.set(options.scope, scopeMeta);
  }
  const scope = scopeMeta;
  // Controllers in a scope are independent; only per-provider exclusion, gaps
  // and a fair FIFO start queue are shared. No quota data lives in the registry.
  const waiterId = ++registry.attempts;
  const waiterTtlMs = options.waiterTtlMs ?? DEFAULT_WAITER_TTL_MS;
  const ownerKey = options.owner;
  let ownerGeneration = 0;
  if (ownerKey !== undefined) {
    ownerGeneration = (scope.owners.get(ownerKey) ?? 0) + 1;
    scope.owners.set(ownerKey, ownerGeneration);
    for (const meta of scope.providers.values()) {
      meta.waiters = meta.waiters.filter((w) => w.owner !== ownerKey);
    }
  }
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let stopped = false;

  const jobs = new Map<PollingProviderId, PollJob>();
  for (const job of options.jobs) {
    if ((job.providerId as string) === PROVIDER.CLAUDE_CODE) {
      throw new Error("Claude Code is response-driven and cannot be polled.");
    }
    jobs.set(job.providerId, job);
  }
  const controllers = new Map<PollingProviderId, AbortController>();

  function metaFor(providerId: PollingProviderId): ProviderMeta {
    let meta = scope.providers.get(providerId);
    if (meta === undefined) {
      meta = { failureCount: 0, waiters: [] };
      scope.providers.set(providerId, meta);
    }
    return meta;
  }

  /** Aborts only this controller's own work; shared state keeps exclusion. */
  function shutdown(): void {
    stopped = true;
    for (const providerId of jobs.keys()) leaveQueue(metaFor(providerId));
    for (const controller of controllers.values()) controller.abort();
  }

  /** A replaced owner generation retires this controller on first contact. */
  function isLive(): boolean {
    if (
      !stopped &&
      ownerKey !== undefined &&
      scope.owners.get(ownerKey) !== ownerGeneration
    ) {
      shutdown();
    }
    return !stopped;
  }

  function leaveQueue(meta: ProviderMeta): void {
    meta.waiters = meta.waiters.filter((w) => w.id !== waiterId);
  }

  /** Registers or refreshes this controller; true when it heads the queue. */
  function hasTurn(meta: ProviderMeta, now: number): boolean {
    meta.waiters = meta.waiters.filter(
      (w) => w.id === waiterId || now - w.seenMs <= waiterTtlMs,
    );
    const mine = meta.waiters.find((w) => w.id === waiterId);
    if (mine === undefined) {
      meta.waiters.push({
        id: waiterId,
        seenMs: now,
        ...(ownerKey === undefined ? {} : { owner: ownerKey }),
      });
    } else {
      mine.seenMs = now;
    }
    return meta.waiters[0]?.id === waiterId;
  }

  function gapFor(providerId: PollingProviderId, active: boolean): number {
    const gaps = options.gaps?.[providerId] ?? DEFAULT_GAPS[providerId];
    return active ? gaps.activeMs : gaps.idleMs;
  }

  function isActive(meta: ProviderMeta, now: number): boolean {
    return (
      meta.lastActivityMs !== undefined &&
      now - meta.lastActivityMs <= ACTIVITY_WINDOW_MS
    );
  }

  function eligibleAt(providerId: PollingProviderId, now: number): number {
    const meta = metaFor(providerId);
    const gapEnd =
      meta.lastAttemptMs === undefined
        ? 0
        : meta.lastAttemptMs + gapFor(providerId, isActive(meta, now));
    return Math.max(
      gapEnd,
      meta.serverRetryAtMs ?? 0,
      meta.backoffUntilMs ?? 0,
    );
  }

  function snapshot(providerId: PollingProviderId): ProviderSchedule {
    const meta = metaFor(providerId);
    const now = options.now();
    return {
      ...(meta.lastAttemptMs === undefined
        ? {}
        : { lastAttemptMs: meta.lastAttemptMs }),
      ...(meta.lastSuccessMs === undefined
        ? {}
        : { lastSuccessMs: meta.lastSuccessMs }),
      nextEligibleMs: eligibleAt(providerId, now),
      inFlight: meta.inFlight !== undefined,
      failureCount: meta.failureCount,
      ...(meta.lastError === undefined ? {} : { lastError: meta.lastError }),
      ...(meta.blocked === undefined ? {} : { blocked: meta.blocked }),
      recentlyActive: isActive(meta, now),
    };
  }

  function jitteredBackoff(failureCount: number): number {
    const grown = Math.min(
      backoff.baseMs * 2 ** Math.min(failureCount - 1, 30),
      backoff.maxMs,
    );
    const random = Math.min(Math.max(options.random(), 0), 0.999999999);
    return grown + Math.floor(random * Math.max(backoff.jitterMs, 0));
  }

  function record(outcome: PollOutcome, meta: ProviderMeta): void {
    const now = options.now();
    if (outcome.kind === POLL_OUTCOME.SUCCESS) {
      meta.lastSuccessMs = now;
      meta.failureCount = 0;
      delete meta.lastError;
      delete meta.blocked;
      delete meta.serverRetryAtMs;
      delete meta.backoffUntilMs;
      return;
    }
    if (outcome.kind !== POLL_OUTCOME.FAILURE) return;
    meta.failureCount += 1;
    meta.lastError = REGISTRY_ERROR[outcome.failure];
    if (outcome.retryAtMs === undefined) delete meta.serverRetryAtMs;
    else meta.serverRetryAtMs = outcome.retryAtMs;
    if (
      outcome.failure === POLL_FAILURE.AUTHENTICATION ||
      outcome.failure === POLL_FAILURE.MANUAL
    ) {
      meta.blocked = outcome.failure;
      delete meta.backoffUntilMs;
    } else {
      meta.backoffUntilMs = now + jitteredBackoff(meta.failureCount);
    }
  }

  async function execute(
    job: PollJob,
    signal: AbortSignal,
  ): Promise<PollOutcome> {
    try {
      const outcome = await job.run(signal);
      if (
        typeof outcome !== "object" ||
        outcome === null ||
        outcome.providerId !== job.providerId ||
        !OUTCOME_KINDS.includes(outcome.kind)
      ) {
        return recoverableFailure(job.providerId);
      }
      if (outcome.kind === POLL_OUTCOME.SUCCESS) {
        // Only a real ready result with valid windows counts as success.
        const checked = toPollOutcome(job.providerId, outcome.result);
        return checked.kind === POLL_OUTCOME.SUCCESS
          ? checked
          : recoverableFailure(job.providerId);
      }
      if (
        outcome.kind === POLL_OUTCOME.FAILURE &&
        !FAILURE_KINDS.includes(outcome.failure)
      ) {
        return recoverableFailure(job.providerId);
      }
      return outcome;
    } catch {
      return recoverableFailure(job.providerId);
    }
  }

  function start(job: PollJob): void {
    const { providerId } = job;
    const meta = metaFor(providerId);
    const attempt = ++registry.attempts;
    const controller = new AbortController();
    meta.inFlight = attempt;
    meta.lastAttemptMs = options.now();
    controllers.set(providerId, controller);
    leaveQueue(meta);

    void execute(job, controller.signal).then(async (outcome) => {
      // Exclusion ends only here, whatever happened to the controller.
      if (meta.inFlight === attempt) delete meta.inFlight;
      if (controllers.get(providerId) === controller) {
        controllers.delete(providerId);
      }
      // A replaced or stopped controller never publishes or records a result;
      // only a validated server cooldown may be kept, and never shortened. A
      // validated authentication failure still blocks the shared provider with
      // fixed sanitized text, so the next controller does not repeat it.
      if (controller.signal.aborted || !isLive()) {
        if (outcome.kind === POLL_OUTCOME.FAILURE) {
          if (
            typeof outcome.retryAtMs === "number" &&
            Number.isFinite(outcome.retryAtMs)
          ) {
            meta.serverRetryAtMs = Math.max(
              meta.serverRetryAtMs ?? 0,
              outcome.retryAtMs,
            );
          }
          if (outcome.failure === POLL_FAILURE.AUTHENTICATION) {
            meta.failureCount += 1;
            meta.lastError = REGISTRY_ERROR[outcome.failure];
            meta.blocked = POLL_FAILURE.AUTHENTICATION;
            delete meta.backoffUntilMs;
          }
        }
        return;
      }
      record(outcome, meta);
      try {
        await options.deliver(outcome, snapshot(providerId));
      } catch {
        // Delivery failures must not break scheduling.
      }
    });
  }

  function cancel(providerId: PollingProviderId): void {
    controllers.get(providerId)?.abort();
  }

  function tick(): PollingProviderId[] {
    if (!isLive()) return [];
    const started: PollingProviderId[] = [];
    const now = options.now();
    for (const job of jobs.values()) {
      const meta = metaFor(job.providerId);
      if (!job.enabled()) {
        cancel(job.providerId);
        leaveQueue(meta);
        continue;
      }
      if (meta.blocked !== undefined) {
        leaveQueue(meta);
        continue;
      }
      if (
        !hasTurn(meta, now) ||
        meta.inFlight !== undefined ||
        eligibleAt(job.providerId, now) > now
      ) {
        continue;
      }
      start(job);
      started.push(job.providerId);
    }
    return started;
  }

  function retry(providerId: PollingProviderId): RetryResult {
    const job = jobs.get(providerId);
    if (job === undefined) return { status: RETRY_STATUS.UNKNOWN };
    if (!isLive()) return { status: RETRY_STATUS.STOPPED };
    if (!job.enabled()) return { status: RETRY_STATUS.DISABLED };
    const meta = metaFor(providerId);
    if (meta.inFlight !== undefined) return { status: RETRY_STATUS.IN_FLIGHT };
    delete meta.blocked;
    const eligibleAtMs = eligibleAt(providerId, options.now());
    if (eligibleAtMs > options.now()) {
      return { status: RETRY_STATUS.DEFERRED, eligibleAtMs };
    }
    start(job);
    return { status: RETRY_STATUS.STARTED };
  }

  return {
    tick,
    retry,
    cancel,
    noteActivity(providerId) {
      if (isLive() && jobs.has(providerId)) {
        metaFor(providerId).lastActivityMs = options.now();
      }
    },
    schedule(providerId) {
      return jobs.has(providerId) ? snapshot(providerId) : undefined;
    },
    stop: shutdown,
  };
}
