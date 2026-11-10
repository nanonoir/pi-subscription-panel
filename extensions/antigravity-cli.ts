import { spawn } from "node:child_process";
import {
  AVAILABILITY,
  CAPABILITY,
  PROVIDER,
  type PollingAdapter,
} from "./quota-contracts.ts";
import type { QuotaResult } from "./quota-contracts.ts";
import type { PollMetadata } from "./poll-outcome.ts";
import { parseAntigravity } from "./provider-adapters.ts";

const date = (value: number): string | undefined =>
  Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString()
    : undefined;

export interface RunOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  shell: boolean;
  stdio: ["ignore", "pipe", "ignore"];
  env: NodeJS.ProcessEnv;
}
/** Caller-provided cancellation; a runner may set `settled` synchronously. */
export interface RunControl {
  signal?: AbortSignal;
  /** Resolves only once the owned child has confirmed exit/close or never spawned. */
  settled?: Promise<void>;
}
export type Runner = (
  binary: string,
  args: string[],
  options: RunOptions,
  control?: RunControl,
) => Promise<string>;
/** Rejection reason when the caller aborted; carries no process output. */
export class RunCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}
// Settles once, independently of "close" on any failure or deadline. Only the
// directly spawned child is killed; descendants and shared engines are left alone.
// `control.settled` resolves only on confirmed exit/close or a verified spawn
// failure; a timeout or failed kill never counts as termination.
const run: Runner = (binary, args, options, control = {}) =>
  new Promise((resolve, reject) => {
    const { timeout, maxBuffer, ...spawnOptions } = options;
    const { signal } = control;
    if (signal?.aborted) {
      control.settled = Promise.resolve();
      return reject(new RunCancelled());
    }
    const child = spawn(binary, args, spawnOptions);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let exited = false;
    let markEnded = () => {};
    control.settled = new Promise<void>((done) => {
      markEnded = done;
    });
    const ended = () => {
      exited = true;
      markEnded();
    };
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (reason: Error = new Error()) => {
      if (settled) return;
      finish();
      chunks.length = 0;
      child.stdout.destroy();
      if (!exited) child.kill("SIGKILL");
      reject(reason);
    };
    const onAbort = () => fail(new RunCancelled());
    const timer = setTimeout(() => fail(), timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBuffer) fail();
      else chunks.push(chunk);
    });
    child.stdout.on("error", () => fail());
    child.on("exit", ended);
    child.on("error", () => {
      fail();
      // Without a pid the process never started; otherwise (e.g. a failed
      // kill) it may still be alive, so only exit/close may end it.
      if (child.pid === undefined) ended();
    });
    child.on("close", (code, exitSignal) => {
      ended();
      if (code !== 0 || exitSignal) return fail();
      if (settled) return;
      finish();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

/** Scheduler-facing result: feed `result` and `meta` to `toPollOutcome`. */
export interface AntigravityPoll {
  result: QuotaResult;
  /** No HTTP status is ever set; indeterminate failures require manual retry. */
  meta: PollMetadata;
  /** Resolves only when the owned child (if any) is confirmed ended; may stay pending. */
  settled: Promise<void>;
}

export type AntigravityAdapter = PollingAdapter & {
  poll(options?: { signal?: AbortSignal }): Promise<AntigravityPoll>;
};

export function createAntigravityAdapter(
  options: { enabled?: boolean; runner?: Runner; now?: () => number } = {},
): AntigravityAdapter {
  const adapter: AntigravityAdapter = {
    providerId: PROVIDER.ANTIGRAVITY,
    capability: CAPABILITY.READ_ONLY_POLLING,
    async refresh() {
      return (await adapter.poll()).result;
    },
    async poll({ signal } = {}) {
      const control: RunControl = { signal };
      const done = (result: QuotaResult, meta: PollMetadata = {}) => ({
        result,
        meta,
        settled: control.settled ?? Promise.resolve(),
      });
      const cancelled = () =>
        done(
          {
            providerId: PROVIDER.ANTIGRAVITY,
            availability: AVAILABILITY.WAITING,
            pools: [],
          },
          { cancelled: true },
        );
      if (!options.enabled)
        return done({
          providerId: PROVIDER.ANTIGRAVITY,
          availability: AVAILABILITY.WAITING,
          pools: [],
        });
      if (signal?.aborted) return cancelled();
      try {
        const raw = await (options.runner ?? run)(
          process.env.AGY_BIN || "agy",
          [
            "--print",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            "30s",
          ],
          {
            timeout: 35000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false,
            stdio: ["ignore", "pipe", "ignore"],
            env: process.env,
          },
          control,
        );
        if (signal?.aborted) return cancelled();
        const observedAt = date((options.now ?? Date.now)());
        const parsed =
          observedAt &&
          parseAntigravity(JSON.parse(raw) as unknown, observedAt);
        if (parsed) return done(parsed);
        return done(
          {
            providerId: PROVIDER.ANTIGRAVITY,
            availability: AVAILABILITY.UNAVAILABLE,
            pools: [],
          },
          { requireManualRetry: true },
        );
      } catch (error) {
        if (error instanceof RunCancelled || signal?.aborted)
          return cancelled();
        return done(
          {
            providerId: PROVIDER.ANTIGRAVITY,
            availability: AVAILABILITY.ERROR,
            pools: [],
            detail: "Quota refresh failed",
          },
          { requireManualRetry: true },
        );
      }
    },
  };
  return adapter;
}
