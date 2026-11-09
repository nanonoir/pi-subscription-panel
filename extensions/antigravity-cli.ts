import { spawn } from "node:child_process";
import {
  AVAILABILITY,
  CAPABILITY,
  PROVIDER,
  type PollingAdapter,
} from "./quota-contracts.ts";
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
export type Runner = (
  binary: string,
  args: string[],
  options: RunOptions,
) => Promise<string>;
// Settles once, independently of "close" on any failure or deadline. Only the
// directly spawned child is killed; descendants and shared engines are left alone.
const run: Runner = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const { timeout, maxBuffer, ...spawnOptions } = options;
    const child = spawn(binary, args, spawnOptions);
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let exited = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      child.stdout.destroy();
      if (!exited) child.kill("SIGKILL");
      reject(new Error());
    };
    const timer = setTimeout(fail, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBuffer) fail();
      else chunks.push(chunk);
    });
    child.stdout.on("error", fail);
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      exited = true;
      if (code !== 0 || signal) return fail();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

export function createAntigravityAdapter(
  options: { enabled?: boolean; runner?: Runner; now?: () => number } = {},
): PollingAdapter {
  return {
    providerId: PROVIDER.ANTIGRAVITY,
    capability: CAPABILITY.READ_ONLY_POLLING,
    async refresh() {
      if (!options.enabled)
        return {
          providerId: PROVIDER.ANTIGRAVITY,
          availability: AVAILABILITY.WAITING,
          pools: [],
        };
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
        );
        const observedAt = date((options.now ?? Date.now)());
        const result =
          observedAt &&
          parseAntigravity(JSON.parse(raw) as unknown, observedAt);
        return (
          result || {
            providerId: PROVIDER.ANTIGRAVITY,
            availability: AVAILABILITY.UNAVAILABLE,
            pools: [],
          }
        );
      } catch {
        return {
          providerId: PROVIDER.ANTIGRAVITY,
          availability: AVAILABILITY.ERROR,
          pools: [],
          detail: "Quota refresh failed",
        };
      }
    },
  };
}
