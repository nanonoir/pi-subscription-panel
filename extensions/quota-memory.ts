import { createHmac, randomBytes } from "node:crypto";
import type { ProviderId, QuotaPool, QuotaSource } from "./quota-contracts.ts";

// Owner-approved, process-local, memory-only retention of the last successful
// quota observations so a reload can show them again. Nothing here is written to
// disk or shared across processes, and it holds no credential, token or account
// identifier: an entry is bound to an opaque keyed digest of its authentication
// context, and any mismatch invalidates it. Scheduling metadata stays in the
// separate refresh registry.

/** Windows observed longer ago than this are never restored. */
export const MEMORY_MAX_AGE_MS = 60 * 60_000;
export const MEMORY_MAX_ENTRIES = 16;
export const MEMORY_MAX_WINDOWS = 32;
const MEMORY_MAX_VERSIONS = 64;
const MAX_ID_LENGTH = 128;
const MAX_KEY_LENGTH = 1024;

interface Entry {
  storedAtMs: number;
  /** Keyed digest of the authentication context the data was read under. */
  context: string;
  pools: QuotaPool[];
}

interface MemoryRegistry {
  version: 1;
  /** Random per process, never persisted or exposed: digests are not portable. */
  key: Buffer;
  entries: Map<string, Entry>;
  /** Monotonic mutation clock and the last tick each entry key changed at. */
  clock: number;
  floor: number;
  versions: Map<string, number>;
}

const REGISTRY_KEY = Symbol.for("pi-subscription-panel.quota-memory.v1");

function isRegistry(value: unknown): value is MemoryRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as MemoryRegistry).version === 1 &&
    (value as MemoryRegistry).entries instanceof Map &&
    (value as MemoryRegistry).versions instanceof Map &&
    typeof (value as MemoryRegistry).clock === "number" &&
    typeof (value as MemoryRegistry).floor === "number" &&
    Buffer.isBuffer((value as MemoryRegistry).key)
  );
}

export interface QuotaMemory {
  /** Opaque keyed digest of authentication material; never reversible. */
  digest: (namespace: string, material: string) => string;
  /** Keeps a copy of the pools read under `context`; unprovable data is forgotten. */
  remember: (
    scope: string,
    providerId: ProviderId,
    context: string | undefined,
    pools: readonly QuotaPool[],
    now: number,
  ) => void;
  /**
   * Like `remember`, but keeps the newest observation per window (pool + kind)
   * when the entry already belongs to the same context; any other context
   * replaces it. Unprovable or malformed data forgets the entry.
   */
  merge: (
    scope: string,
    providerId: ProviderId,
    context: string | undefined,
    pools: readonly QuotaPool[],
    now: number,
  ) => void;
  /** Removes specific windows (e.g. superseded by unproven data); keeps the rest. */
  drop: (
    scope: string,
    providerId: ProviderId,
    windows: readonly { pool: string; kind: string }[],
  ) => void;
  /**
   * Retained pools for exactly this scope, provider and context, minus windows
   * that are too old or already reset. A different or unprovable context
   * invalidates the entry.
   */
  recall: (
    scope: string,
    providerId: ProviderId,
    context: string | undefined,
    now: number,
  ) => QuotaPool[] | undefined;
  forget: (scope: string, providerId: ProviderId) => void;
  /**
   * Opaque change counter of one scope/provider entry, shared by every runtime in
   * this realm. Every mutation (store, merge, drop, forget, invalidation,
   * eviction) changes it, so a holder can tell its asynchronous work is stale.
   */
  version: (scope: string, providerId: ProviderId) => number;
}

/** Versioned registry shared by every module instance in this realm. */
export function getQuotaMemory(host: object = globalThis): QuotaMemory {
  const slots = host as Record<symbol, unknown>;
  let registry: MemoryRegistry;
  const existing = slots[REGISTRY_KEY];
  if (isRegistry(existing)) registry = existing;
  else {
    registry = {
      version: 1,
      key: randomBytes(32),
      entries: new Map(),
      clock: 0,
      floor: 0,
      versions: new Map(),
    };
    slots[REGISTRY_KEY] = registry;
  }
  const shared = registry;

  const entryKey = (scope: string, providerId: ProviderId): string =>
    `${scope}\0${providerId}`;

  /** Marks the entry key as changed; bounded, and pruning only moves versions up. */
  function bump(key: string): void {
    shared.versions.delete(key);
    shared.versions.set(key, ++shared.clock);
    if (shared.versions.size > MEMORY_MAX_VERSIONS) {
      const oldest = shared.versions.keys().next().value as string;
      shared.versions.delete(oldest);
      // Any key without a record now reads above every earlier observation.
      shared.floor = ++shared.clock;
    }
  }

  function remove(key: string): void {
    shared.entries.delete(key);
    bump(key);
  }

  /** Whitelisted copy; undefined when the data is unbounded or malformed. */
  function copyPools(pools: readonly QuotaPool[]): QuotaPool[] | undefined {
    const copy: QuotaPool[] = [];
    let count = 0;
    for (const pool of pools) {
      if (typeof pool.id !== "string" || pool.id.length > MAX_ID_LENGTH)
        return undefined;
      const windows = pool.windows.map((window) => ({
        kind: window.kind,
        remainingPercent: window.remainingPercent,
        observedAt: window.observedAt,
        source: window.source as QuotaSource,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      }));
      count += windows.length;
      if (
        count > MEMORY_MAX_WINDOWS ||
        windows.some(
          (window) =>
            typeof window.kind !== "string" ||
            window.kind.length > MAX_ID_LENGTH ||
            !Number.isFinite(window.remainingPercent) ||
            !Number.isFinite(Date.parse(window.observedAt)),
        )
      )
        return undefined;
      copy.push({ id: pool.id, windows });
    }
    return count > 0 ? copy : undefined;
  }

  /** Newest observation per window; undefined when the result is unbounded. */
  function mergePools(
    existing: readonly QuotaPool[],
    incoming: readonly QuotaPool[],
  ): QuotaPool[] | undefined {
    type Window = QuotaPool["windows"][number];
    const merged = new Map<string, { pool: string; window: Window }>();
    for (const pools of [existing, incoming])
      for (const pool of pools)
        for (const window of pool.windows) {
          const id = `${pool.id}\0${window.kind}`;
          const previous = merged.get(id);
          if (
            previous === undefined ||
            Date.parse(window.observedAt) >=
              Date.parse(previous.window.observedAt)
          )
            merged.set(id, { pool: pool.id, window });
        }
    if (merged.size > MEMORY_MAX_WINDOWS) return undefined;
    const byPool = new Map<string, QuotaPool>();
    for (const { pool, window } of merged.values()) {
      const target = byPool.get(pool) ?? { id: pool, windows: [] };
      target.windows.push({ ...window });
      byPool.set(pool, target);
    }
    return [...byPool.values()];
  }

  function keep(
    key: string,
    context: string,
    pools: QuotaPool[],
    now: number,
  ): void {
    remove(key);
    shared.entries.set(key, { storedAtMs: now, context, pools });
    bump(key);
    while (shared.entries.size > MEMORY_MAX_ENTRIES) {
      let oldest: string | undefined;
      for (const [candidate, entry] of shared.entries) {
        if (
          oldest === undefined ||
          entry.storedAtMs < (shared.entries.get(oldest) as Entry).storedAtMs
        )
          oldest = candidate;
      }
      if (oldest === undefined) break;
      remove(oldest);
    }
  }

  /** Whitelisted copy, or undefined (and forgotten) when it cannot be proven. */
  function prepare(
    scope: string,
    providerId: ProviderId,
    context: string | undefined,
    pools: readonly QuotaPool[],
  ): QuotaPool[] | undefined {
    const copy =
      context === undefined || scope.length > MAX_KEY_LENGTH
        ? undefined
        : copyPools(pools);
    if (copy === undefined) remove(entryKey(scope, providerId));
    return copy;
  }

  return {
    digest: (namespace, material) =>
      createHmac("sha256", shared.key)
        .update(`${namespace}\0${material}`)
        .digest("hex"),

    remember(scope, providerId, context, pools, now) {
      const copy = prepare(scope, providerId, context, pools);
      if (copy && context !== undefined)
        keep(entryKey(scope, providerId), context, copy, now);
    },

    merge(scope, providerId, context, pools, now) {
      const copy = prepare(scope, providerId, context, pools);
      if (!copy || context === undefined) return;
      const key = entryKey(scope, providerId);
      const existing = shared.entries.get(key);
      const merged =
        existing && existing.context === context
          ? mergePools(existing.pools, copy)
          : undefined;
      keep(key, context, merged ?? copy, now);
    },

    drop(scope, providerId, windows) {
      const key = entryKey(scope, providerId);
      const entry = shared.entries.get(key);
      if (entry === undefined) {
        // Nothing to remove still supersedes any retention waiting on this key.
        bump(key);
        return;
      }
      const gone = new Set(
        windows.map((window) => `${window.pool}\0${window.kind}`),
      );
      const pools = entry.pools
        .map((pool) => ({
          id: pool.id,
          windows: pool.windows.filter(
            (window) => !gone.has(`${pool.id}\0${window.kind}`),
          ),
        }))
        .filter((pool) => pool.windows.length > 0);
      if (pools.length === 0) remove(key);
      else {
        entry.pools = pools;
        bump(key);
      }
    },

    version(scope, providerId) {
      return (
        shared.versions.get(entryKey(scope, providerId)) ??
        // Pruned or never-touched keys read at the floor, above any earlier tick.
        shared.floor
      );
    },

    recall(scope, providerId, context, now) {
      const key = entryKey(scope, providerId);
      const entry = shared.entries.get(key);
      if (entry === undefined) return undefined;
      if (context === undefined || entry.context !== context) {
        remove(key);
        return undefined;
      }
      const pools: QuotaPool[] = [];
      for (const pool of entry.pools) {
        const windows = pool.windows
          .filter(
            (window) =>
              now - Date.parse(window.observedAt) <= MEMORY_MAX_AGE_MS &&
              (window.resetsAt === undefined ||
                !(Date.parse(window.resetsAt) <= now)),
          )
          .map((window) => ({ ...window }));
        if (windows.length > 0) pools.push({ id: pool.id, windows });
      }
      if (pools.length === 0) {
        remove(key);
        return undefined;
      }
      return pools;
    },

    forget(scope, providerId) {
      remove(entryKey(scope, providerId));
    },
  };
}
