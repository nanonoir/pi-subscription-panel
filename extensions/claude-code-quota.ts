import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { toQuotaResult, type LegacyQuotaWindow } from "./legacy-quota.ts";
import {
  POLL_OUTCOME,
  toPollOutcome,
  type PollOutcome,
} from "./poll-outcome.ts";
import { PROVIDER, SOURCE } from "./quota-contracts.ts";

// Owner-approved read-only quota source for Claude Code: one GET of Anthropic's
// OAuth usage endpoint with the access token Claude Code itself stored. It never
// refreshes, logs in, falls back to another credential store or sends
// inference. Credentials, bodies and raw errors are never kept or reported.

export const CLAUDE_CODE_USAGE_URL =
  "https://api.anthropic.com/api/oauth/usage";
/** Conservative floor between reads, also applied after a 429. */
export const CLAUDE_CODE_MIN_GAP_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 4096;

export const claudeCodeCredentialPath = (): string =>
  join(homedir(), ".claude", ".credentials.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const UNAVAILABLE = "sin sesión de Claude Code";

class Unavailable extends Error {}

/** Reads only the access token of the exact Claude Code credential file. */
async function readAccessToken(now: number): Promise<string> {
  const path = claudeCodeCredentialPath();
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Unavailable();
  // POSIX only: a group/world-accessible credential file is not trusted.
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Unavailable();
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
  if (!isRecord(oauth)) throw new Unavailable();
  const { accessToken, expiresAt } = oauth;
  if (
    typeof accessToken !== "string" ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    !/^[\x21-\x7e]+$/.test(accessToken)
  )
    throw new Unavailable();
  // An expired session is never renewed here; Claude Code owns its renewal.
  if (typeof expiresAt === "number" && expiresAt <= now)
    throw new Unavailable();
  return accessToken;
}

/**
 * Opaque digest of the current Claude Code session, for in-memory quota
 * retention only: compared with the digest of the token a request actually used,
 * and re-derived on restore. Reads the same credential file as the reader, with no network,
 * refresh or output; any problem (including an expired session) is undefined.
 */
export async function readClaudeCodeAuthContext(
  now: number,
  digest: (material: string) => string,
): Promise<string | undefined> {
  try {
    return digest(await readAccessToken(now));
  } catch {
    return undefined;
  }
}

function parseWindow(value: unknown): LegacyQuotaWindow | undefined {
  if (!isRecord(value) || typeof value.utilization !== "number")
    return undefined;
  if (!Number.isFinite(value.utilization)) return undefined;
  if (value.resets_at === null || value.resets_at === undefined)
    return { usedPercent: value.utilization };
  if (typeof value.resets_at !== "string") return undefined;
  const resetsAt = Date.parse(value.resets_at);
  return Number.isFinite(resetsAt)
    ? { usedPercent: value.utilization, resetsAt }
    : undefined;
}

/** Bounded body read: aborts and cancels as soon as the limit is exceeded. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new Error("body too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error("body too large");
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => undefined);
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const at = Number.isFinite(Number(header))
    ? now + Math.max(0, Number(header)) * 1000
    : Date.parse(header);
  return Number.isFinite(at) ? at : undefined;
}

const failure = (
  detail: string,
  meta: Parameters<typeof toPollOutcome>[2] = {},
  now = 0,
): PollOutcome =>
  toPollOutcome(
    PROVIDER.CLAUDE_CODE,
    toQuotaResult(
      PROVIDER.CLAUDE_CODE,
      { error: detail },
      now,
      SOURCE.READ_ONLY_ENDPOINT,
    ),
    meta,
  );

/** One bounded read. Never throws; every failure is a sanitized outcome. */
export async function readClaudeCodeQuota(
  signal: AbortSignal,
  now: () => number,
  /** Digests the token actually sent, binding retention to that credential. */
  digest?: (material: string) => string,
): Promise<PollOutcome> {
  const cancelled = (): PollOutcome => ({
    kind: POLL_OUTCOME.CANCELLED,
    providerId: PROVIDER.CLAUDE_CODE,
  });
  try {
    let accessToken: string;
    try {
      accessToken = await readAccessToken(now());
    } catch {
      // Missing, unreadable, insecure or expired: transient, no request made.
      return signal.aborted ? cancelled() : failure(UNAVAILABLE, {}, now());
    }
    if (signal.aborted) return cancelled();
    const response = await fetch(CLAUDE_CODE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });
    if (!response.ok) {
      const status = response.status;
      const serverRetry = retryAfterMs(response, now());
      try {
        response.body?.cancel().catch(() => undefined);
      } catch {
        // Cleanup is best effort and never replaces the known status.
      }
      const deadlines = [
        ...(serverRetry === undefined ? [] : [serverRetry]),
        ...(status === 429 ? [now() + CLAUDE_CODE_MIN_GAP_MS] : []),
      ];
      return failure(
        `HTTP ${status}`,
        {
          httpStatus: status,
          ...(deadlines.length ? { retryAtMs: Math.max(...deadlines) } : {}),
        },
        now(),
      );
    }
    const payload = await readBoundedJson(response);
    const body = isRecord(payload) ? payload : {};
    const fiveHour = parseWindow(body.five_hour);
    const weekly = parseWindow(body.seven_day);
    if (!fiveHour && !weekly)
      return failure("ventanas ausentes o formato cambiado", {}, now());
    return toPollOutcome(
      PROVIDER.CLAUDE_CODE,
      toQuotaResult(
        PROVIDER.CLAUDE_CODE,
        {
          ...(fiveHour ? { fiveHour } : {}),
          ...(weekly ? { weekly } : {}),
        },
        now(),
        SOURCE.READ_ONLY_ENDPOINT,
      ),
      digest ? { authContext: digest(accessToken) } : {},
    );
  } catch (error) {
    if (signal.aborted) return cancelled();
    const name = isRecord(error) ? error.name : undefined;
    const label =
      name === "TimeoutError"
        ? "timeout"
        : name === "TypeError"
          ? "error de red"
          : "error de consulta";
    return failure(label, {}, now());
  }
}
