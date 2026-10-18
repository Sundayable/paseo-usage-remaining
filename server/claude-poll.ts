import { createHash } from "node:crypto";
import type { RemainingRow } from "../shared/usage";

export type ClaudeCredential = {
  token: string;
  expiresAt: number | null;
  source: "env" | "keychain" | "file";
  description?: string;
};

export const CLAUDE_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60 * 60_000;
const FORBIDDEN_COOLDOWN_MS = 6 * 60 * 60_000;
const SAMPLE_TTL_MS = 6 * 60 * 60_000;

type Sample = { rows: RemainingRow[]; at: number };
export type ClaudePollState = {
  tokenCooldowns: Record<string, number>;
  lastAttempts: Record<string, number>;
  samples: Record<string, Sample>;
  errors: Record<string, string>;
  headerAttempts: Record<string, number>;
  headerCooldowns: Record<string, number>;
  headerErrors: Record<string, string>;
  legacyLastAt?: number;
};

export function credentialKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function emptyClaudeState(): ClaudePollState {
  return { tokenCooldowns: {}, lastAttempts: {}, samples: {}, errors: {}, headerAttempts: {}, headerCooldowns: {}, headerErrors: {} };
}

// Retain old cooldowns, but never migrate the old unscoped 100% rows into a
// worker sample. Those rows could belong to an entirely different organization.
export function restoreClaudeState(raw: unknown, now = Date.now()): ClaudePollState {
  const state = emptyClaudeState();
  if (!raw || typeof raw !== "object") return state;
  const saved = raw as Partial<ClaudePollState> & { lastAt?: number };
  const legacyAt = saved.legacyLastAt ?? saved.lastAt;
  if (typeof legacyAt === "number" && Number.isFinite(legacyAt)) state.legacyLastAt = legacyAt;
  for (const [key, until] of Object.entries(saved.tokenCooldowns ?? {})) {
    if (/^[a-f0-9]{16}$/.test(key) && Number.isFinite(until) && until > now) state.tokenCooldowns[key] = until;
  }
  for (const [key, at] of Object.entries(saved.lastAttempts ?? {})) {
    if (/^[a-f0-9]{16}$/.test(key) && Number.isFinite(at)) state.lastAttempts[key] = at;
  }
  for (const [key, sample] of Object.entries(saved.samples ?? {})) {
    if (/^[a-f0-9]{16}$/.test(key) && sample && Number.isFinite(sample.at) && now - sample.at <= SAMPLE_TTL_MS && Array.isArray(sample.rows)) {
      state.samples[key] = sample;
    }
  }
  for (const [key, error] of Object.entries(saved.errors ?? {})) {
    if (/^[a-f0-9]{16}$/.test(key) && /^(HTTP \d{3}( \(missing user:profile scope\))?|network error|no usage data)$/.test(error)) state.errors[key] = error;
  }
  for (const name of ["headerAttempts", "headerCooldowns"] as const) {
    for (const [key, value] of Object.entries(saved[name] ?? {})) {
      if (/^[a-f0-9]{16}$/.test(key) && Number.isFinite(value)) state[name][key] = value;
    }
  }
  for (const [key, error] of Object.entries(saved.headerErrors ?? {})) {
    if (/^[a-f0-9]{16}$/.test(key) && /^(HTTP \d{3}|network error|no quota headers)$/.test(error)) state.headerErrors[key] = error;
  }
  return state;
}

export function retryDelay(value: string | null, now: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date) && date > now) return date - now;
  }
  return DEFAULT_COOLDOWN_MS;
}

type Dependencies = {
  readCredentials(): Promise<{ creds: ClaudeCredential[]; loginRecord: boolean }>;
  request(token: string): Promise<Response>;
  parse(body: unknown): RemainingRow[];
  headerProbe?: { request(token: string): Promise<Response>; parse(headers: Headers): RemainingRow[] };
  fallback(): RemainingRow[];
  signedOut(): RemainingRow[];
  state: ClaudePollState;
  changed(): void;
  persist?(): Promise<void>;
  now?(): number;
  log?(message: string): void;
};

export function createClaudePoller(deps: Dependencies): () => Promise<RemainingRow[]> {
  let inFlight: Promise<RemainingRow[]> | undefined;
  const state = deps.state;
  const now = deps.now ?? Date.now;

  function cached(key: string, at: number): RemainingRow[] | null {
    const sample = state.samples[key];
    if (!sample || at - sample.at > SAMPLE_TTL_MS) return null;
    const rows = sample.rows.map((row) => {
      if (!row.resetIso || Date.parse(row.resetIso) > at) return row;
      return { ...row, status: "error" as const, remainingPct: null, remainingText: "—", resetIso: null, resetAt: null, tone: "default" as const, detail: "window reset · waiting for provider" };
    });
    return rows.some((row) => row.status === "available") ? rows : null;
  }

  function decorate(rows: RemainingRow[], cred: ClaudeCredential, reason?: string, observedAt?: number): RemainingRow[] {
    const isWorker = cred.source === "env";
    const source = isWorker ? "workers" : "fallback";
    const detail = [
      isWorker ? "worker token" : `${cred.source} fallback · may be a different account from workers`,
      cred.description,
      observedAt != null ? `cached usage · observed ${new Date(observedAt).toISOString()}` : undefined,
      reason,
    ].filter(Boolean).join(" · ");
    return rows.map((row) => ({ ...row, label: `${row.label} (${source})`, detail: [detail, row.detail].filter(Boolean).join(" · ") }));
  }

  async function poll(): Promise<RemainingRow[]> {
    const { creds, loginRecord } = await deps.readCredentials();
    // Order again here so credential readers cannot accidentally restore the old priority.
    const ordered = [...creds].sort((a, b) => Number(b.source === "env") - Number(a.source === "env"));
    const seen = new Set<string>();
    let workerReason: string | undefined;
    let lastUnavailable: { cred: ClaudeCredential; reason: string } | undefined;
    for (const cred of ordered) {
      const at = now();
      const key = credentialKey(cred.token);
      if (seen.has(key)) continue;
      seen.add(key);
      if (cred.expiresAt != null && cred.expiresAt <= at + 30_000) {
        if (cred.source === "env") workerReason = "worker token expired";
        continue;
      }
      const cooldown = state.tokenCooldowns[key] ?? 0;
      const throttled = at - Math.max(state.lastAttempts[key] ?? -Infinity, state.legacyLastAt ?? -Infinity) < CLAUDE_MIN_INTERVAL_MS;
      let reason = state.errors[key];
      if (cooldown > at) {
        reason = `${reason ?? "rate limited"} · retry after ${new Date(cooldown).toISOString()}`;
      } else if (!throttled) {
        // Record every attempt, including failures, before awaiting the request.
        state.lastAttempts[key] = at;
        deps.changed();
        try {
          const response = await deps.request(cred.token);
          if (response.ok) {
            const rows = deps.parse(await response.json());
            if (rows.some((row) => row.status === "available")) {
              state.samples[key] = { rows, at: now() };
              delete state.errors[key];
              delete state.tokenCooldowns[key];
              deps.changed();
              deps.log?.(`ok via ${cred.source} token${cred.source === "env" ? " (workers)" : " (labelled fallback)"}`);
              return decorate(rows, cred, workerReason);
            }
            reason = "no usage data";
          } else {
            reason = `HTTP ${response.status}`;
            if (response.status === 403) {
              // Only retain this fixed diagnostic, never an arbitrary server body
              // that could echo credentials or other private request details.
              const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
              const message = body?.error?.message;
              if (typeof message === "string" && /scope/i.test(message) && /user:profile/.test(message)) {
                reason = "HTTP 403 (missing user:profile scope)";
              }
            }
            if (response.status === 429 || response.status === 403) {
              const delay = response.status === 403 ? FORBIDDEN_COOLDOWN_MS : retryDelay(response.headers.get("retry-after"), now());
              state.tokenCooldowns[key] = now() + delay;
            }
          }
        } catch {
          // Exceptions can contain request headers. Never log their raw contents.
          reason = "network error";
        }
        state.errors[key] = reason;
        deps.changed();
        deps.log?.(`${reason} from ${cred.source} token`);
      }
      // Usage-read cooldowns do not apply to the separately authorized minimal
      // inference probe. Its own persisted limits include failed attempts.
      if (cred.source === "env" && reason && deps.headerProbe) {
        const probeAt = now();
        if (probeAt - (state.headerAttempts[key] ?? -Infinity) >= CLAUDE_MIN_INTERVAL_MS &&
            (state.headerCooldowns[key] ?? 0) <= probeAt) {
          state.headerAttempts[key] = probeAt;
          deps.changed();
          await deps.persist?.();
          let probeError: string;
          try {
            const response = await deps.headerProbe.request(cred.token);
            const rows = deps.headerProbe.parse(response.headers);
            // Read metadata only; never retain generated content or error bodies.
            await response.body?.cancel();
            if (response.status === 429) state.headerCooldowns[key] = now() + Math.max(CLAUDE_MIN_INTERVAL_MS, retryDelay(response.headers.get("retry-after"), now()));
            if (response.status === 401 || response.status === 403) state.headerCooldowns[key] = now() + FORBIDDEN_COOLDOWN_MS;
            if ((response.ok || response.status === 429) && rows.some((row) => row.status === "available")) {
              state.samples[key] = { rows, at: now() };
              delete state.headerErrors[key];
              deps.changed();
              deps.log?.("ok via env token (Haiku response headers)");
              return decorate(rows, cred, `usage API unavailable · ${reason}`);
            }
            probeError = response.ok ? "no quota headers" : `HTTP ${response.status}`;
          } catch {
            probeError = "network error";
          }
          state.headerErrors[key] = probeError;
          deps.changed();
          deps.log?.(`Haiku header probe: ${probeError}`);
        }
        if (state.headerErrors[key]) reason += ` · Haiku header probe: ${state.headerErrors[key]}`;
      }
      const sample = cached(key, now());
      if (sample) return decorate(sample, cred, [workerReason, reason].filter(Boolean).join(" · "), reason ? state.samples[key].at : undefined);
      if (cred.source === "env") workerReason = `worker usage unavailable${cred.description ? ` (${cred.description})` : ""} · ${reason ?? "waiting for next poll"}`;
      lastUnavailable = { cred, reason: reason ?? "waiting for next poll" };
    }
    // An expired unrelated keychain login must not claim the worker is signed out.
    if (!creds.some((cred) => cred.source === "env") && loginRecord &&
        !creds.some((cred) => cred.expiresAt == null || cred.expiresAt > now() + 30_000)) return deps.signedOut();
    if (workerReason) {
      return deps.fallback().map((row) => ({ ...row, label: `${row.label} (workers)`, remainingText: row.id === "claude_session" ? "unavailable" : "—", status: "error" as const, detail: workerReason }));
    }
    if (lastUnavailable) return decorate(deps.fallback().map((row) => ({ ...row, status: "error" as const })), lastUnavailable.cred, lastUnavailable.reason);
    return deps.fallback();
  }

  return () => {
    if (!inFlight) inFlight = poll().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
