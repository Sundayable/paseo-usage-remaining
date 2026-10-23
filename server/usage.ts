import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, lstat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RemainingRow, UsageSnapshot } from "../shared/usage";
import { createClaudePoller, credentialKey, emptyClaudeState, restoreClaudeState, type ClaudeCredential } from "./claude-poll.ts";
export type { ClaudeCredential } from "./claude-poll.ts";

const execFileAsync = promisify(execFile);
const home = homedir();

// One slow provider must not stall the whole usage RPC (the pill then shows
// "Usage…" for every provider). Each request gets its own deadline.
const FETCH_TIMEOUT_MS = 15_000;
function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

type Tone = RemainingRow["tone"];
type Brand = RemainingRow["brand"];
type Group = RemainingRow["group"];

function remainingFromUsed(usedPct: number | null | undefined): number | null {
  if (typeof usedPct !== "number" || Number.isNaN(usedPct)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - usedPct)));
}

function toneFromRemaining(remainingPct: number | null): Tone {
  if (remainingPct == null) return "default";
  if (remainingPct > 50) return "ok";
  if (remainingPct > 20) return "warning";
  return "danger";
}

function pctText(remainingPct: number | null): string {
  return remainingPct == null ? "—" : `${remainingPct}%`;
}

function resetLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const delta = date.getTime() - now;
  if (delta <= 0) return "now";
  const totalMinutes = Math.max(1, Math.floor(delta / 60_000));
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 1) return `${totalMinutes}m`;
  if (totalHours < 24) {
    const remMinutes = totalMinutes % 60;
    return remMinutes === 0 ? `${totalHours}h` : `${totalHours}h ${remMinutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  if (days >= 3 || remHours === 0) return `${days}d`;
  return `${days}d ${remHours}h`;
}

function baseRow(id: string, brand: Brand, group: Group, label: string): RemainingRow {
  return {
    id,
    brand,
    group,
    label,
    remainingText: "—",
    remainingPct: null,
    resetAt: null,
    resetIso: null,
    detail: "not signed in or no usage data",
    tone: "default",
    status: "unavailable",
  };
}

function row(
  id: string,
  brand: Brand,
  group: Group,
  label: string,
  remainingPct: number | null,
  resetIso: string | null | undefined,
  detail: string | null = null,
): RemainingRow {
  return {
    id,
    brand,
    group,
    label,
    remainingText: pctText(remainingPct),
    remainingPct,
    resetAt: resetLabel(resetIso),
    resetIso: resetIso ?? null,
    detail,
    tone: toneFromRemaining(remainingPct),
    status: remainingPct == null ? "unavailable" : "available",
  };
}

async function readJson(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// claude-paseo sources this file at process launch. It must take precedence over
// the daemon's inherited environment and the unrelated interactive Claude login.
export async function readClaudeEnvToken(
  root: string = home,
  inheritedToken: string | undefined = process.env.CLAUDE_CODE_OAUTH_TOKEN,
): Promise<{ token: string; description: string } | undefined> {
  for (const path of [
    join(root, ".config", "agent-core", "auth", "claude.env"),
    join(root, ".claude", "claude.env"),
  ]) {
    try {
      const env = await readFile(path, "utf8");
      // Parse only a literal assignment. Never source/execute a credential file.
      const token = env.match(/^(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#"']+))\s*(?:#.*)?$/m);
      const value = token?.[1] ?? token?.[2] ?? token?.[3];
      if (value) {
        const labels = await readJson(join(root, ".paseo", "usage-remaining.accounts.json")) as Record<string, unknown> | null;
        const label = labels?.[credentialKey(value)];
        const account = typeof label === "string" ? label.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 100) : null;
        return { token: value, description: [path.replace(root, "~"), account].filter(Boolean).join(" · ") };
      }
    } catch {
      // keep looking
    }
  }
  return inheritedToken ? { token: inheritedToken, description: "CLAUDE_CODE_OAUTH_TOKEN" } : undefined;
}

/** Explicit Team B only. Never use the active/personal token or start a login. */
export async function readClaudeTeamCredentials(root: string = home): Promise<{ creds: ClaudeCredential[]; loginRecord: boolean }> {
  try {
    const path = join(root, ".config/agent-core/auth/claude-b.env");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) return { creds: [], loginRecord: false };
    const text = await readFile(path, "utf8");
    const match = text.match(/^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#"']+))\s*$/);
    const token = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!token) return { creds: [], loginRecord: false };
    const labels = await readJson(join(root, ".paseo/usage-remaining.accounts.json")) as Record<string, unknown> | null;
    if (labels?.[credentialKey(token)] !== "Sundayable Team (B)") return { creds: [], loginRecord: false };
    return { creds: [{ token, expiresAt: null, source: "env", description: "Sundayable Team (B) · claude-team" }], loginRecord: true };
  } catch { return { creds: [], loginRecord: false }; }
}

function parseClaudeCredential(raw: unknown, source: ClaudeCredential["source"]): ClaudeCredential | null {
  const oauth = (raw as { claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string } } | null)?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null, source, description: oauth.subscriptionType ? `Claude ${oauth.subscriptionType}` : undefined };
}

// A `claudeAiOauth` block, even one with blank tokens, means Claude Code was signed
// in on this machine; a machine that only ever had the env setup token has none.
function hasClaudeLogin(raw: unknown): boolean {
  return Boolean((raw as { claudeAiOauth?: unknown } | null)?.claudeAiOauth);
}

async function readClaudeCredentials(): Promise<{ creds: ClaudeCredential[]; loginRecord: boolean }> {
  const found: ClaudeCredential[] = [];
  const seen = new Set<string>();
  let loginRecord = false;
  const add = (cred: ClaudeCredential | null) => {
    if (cred && !seen.has(cred.token)) {
      seen.add(cred.token);
      found.push(cred);
    }
  };
  const worker = await readClaudeEnvToken();
  if (worker) add({ ...worker, expiresAt: null, source: "env" });
  const account = /^[a-zA-Z0-9._-]+$/.test(process.env.USER || userInfo().username)
    ? process.env.USER || userInfo().username
    : "claude-code-user";
  for (const args of [
    ["find-generic-password", "-a", account, "-w", "-s", "Claude Code-credentials"],
    ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
  ]) {
    try {
      const { stdout } = await execFileAsync("security", args, { timeout: 2000 });
      const raw = JSON.parse(stdout.trim());
      loginRecord ||= hasClaudeLogin(raw);
      add(parseClaudeCredential(raw, "keychain"));
    } catch {
      // keep looking
    }
  }
  const file = await readJson(join(process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_HOME || join(home, ".claude"), ".credentials.json"));
  loginRecord ||= hasClaudeLogin(file);
  add(parseClaudeCredential(file, "file"));
  return { creds: found, loginRecord };
}

// Once the refresh token expires (about a month after `claude auth login`), Claude
// Code blanks both tokens in the keychain. Only the env setup token is left, and
// oauth/usage never serves it, so without this the Claude chips just vanish.
export function claudeLoginExpired(creds: ClaudeCredential[], loginRecord: boolean, now: number = Date.now()): boolean {
  if (!loginRecord) return false;
  return !creds.some((cred) => cred.source !== "env" && (cred.expiresAt == null || cred.expiresAt > now + 30_000));
}

export function claudeSignedOutRows(): RemainingRow[] {
  const detail = "Claude Code login expired · run `claude auth login`";
  return claudeFallbackRows().map((r) => ({
    ...r,
    remainingText: r.id === "claude_session" ? "login expired" : "—",
    detail,
    status: "error" as const,
  }));
}

function claudeFallbackRows(): RemainingRow[] {
  return [
    baseRow("claude_session", "claude", "session", "Claude"),
    baseRow("claude_week", "claude", "weekly", "Claude"),
    baseRow("fable_week", "fable", "weekly", "Fable"),
  ];
}

const claudeState = emptyClaudeState();
const claudeDependencies = {
  state: claudeState,
  request: (token: string) => fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
    },
  }),
  parse: (body: unknown) => parseClaudeUsage(body as ClaudeUsageBody),
  headerProbe: {
    request: (token: string) => fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: "user", content: "." }] }),
    }),
    parse: parseClaudeHeaders,
  },
  fallback: claudeFallbackRows,
  signedOut: claudeSignedOutRows,
  changed: saveCache,
  persist: flushUsageCache,
  log: (message: string) => console.log(`[usage-remaining] claude: ${message}`),
};
const fetchClaude = createClaudePoller({ ...claudeDependencies, readCredentials: readClaudeCredentials });
const fetchClaudeTeam = createClaudePoller({ ...claudeDependencies, readCredentials: readClaudeTeamCredentials });

// Unified utilization is a fraction (0.13 means 13% used), unlike /oauth/usage.
// Missing windows stay unknown and must never be filled from a personal login.
export function parseClaudeHeaders(headers: Headers): RemainingRow[] {
  return ([ ["5h", "session"], ["7d", "weekly"] ] as const).map(([window, group]) => {
    const prefix = `anthropic-ratelimit-unified-${window}`;
    const value = headers.get(`${prefix}-utilization`);
    const used = value?.trim() ? Number(value) : NaN;
    const remaining = Number.isFinite(used) && used >= 0 ? remainingFromUsed(used * 100) : null;
    const reset = Number(headers.get(`${prefix}-reset`));
    const resetMs = reset * 1000;
    const iso = reset > 0 && Number.isFinite(resetMs) && resetMs <= 8.64e15 ? new Date(resetMs).toISOString() : null;
    const result = row(group === "session" ? "claude_session" : "claude_week", "claude", group, "Claude", remaining, iso,
      `Haiku response headers · ${window} quota${remaining == null ? " not reported" : ""}`);
    return remaining == null ? { ...result, remainingText: "unknown", status: "error" as const } : result;
  });
}

type ClaudeWindow = { utilization?: number | null; resets_at?: string | null } | null;
export type ClaudeUsageBody = {
  five_hour?: ClaudeWindow;
  seven_day?: ClaudeWindow;
  seven_day_omelette?: ClaudeWindow;
  seven_day_opus?: ClaudeWindow;
  seven_day_sonnet?: ClaudeWindow;
  limits?: Array<{
    kind?: string;
    group?: string;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null; id?: string | null } | null; surface?: string | null } | null;
  }> | null;
};

function scopeSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "scoped";
}

// Anthropic adds a model-scoped weekly limit per flagship (Fable today; Opus 5.5
// or later models may get one too). Every `weekly_scoped` entry becomes its own row
// so a new limit is never silently hidden: Fable keeps its own brand, any other
// scope is a Claude row labelled with the model name. Legacy `seven_day_*` windows
// cover accounts whose body has no `limits` array.
export function parseClaudeUsage(body: ClaudeUsageBody): RemainingRow[] {
  const rows: RemainingRow[] = [
    row("claude_session", "claude", "session", "Claude", remainingFromUsed(body.five_hour?.utilization), body.five_hour?.resets_at),
    row("claude_week", "claude", "weekly", "Claude", remainingFromUsed(body.seven_day?.utilization), body.seven_day?.resets_at),
  ];
  const scoped = (body.limits ?? []).filter((entry) => entry?.kind === "weekly_scoped");
  const isFable = (name: string) => name.includes("fable") || name.includes("omelette");
  let fableSeen = false;
  const seenIds = new Set<string>();
  for (const entry of scoped) {
    const model = entry.scope?.model;
    const display = model?.display_name?.trim() || model?.id?.trim() || "";
    const name = `${display} ${model?.id ?? ""}`.toLowerCase();
    if (isFable(name)) {
      if (fableSeen) continue;
      fableSeen = true;
      rows.push(row("fable_week", "fable", "weekly", "Fable", remainingFromUsed(entry.percent), entry.resets_at ?? body.seven_day?.resets_at));
      continue;
    }
    const surface = entry.scope?.surface?.trim();
    const label = display || (surface ? `Claude ${surface}` : "Claude scoped");
    const id = `claude_scoped_${scopeSlug(model?.id || display || surface || "")}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    rows.push(row(id, "claude", "weekly", label, remainingFromUsed(entry.percent), entry.resets_at ?? body.seven_day?.resets_at, "model-scoped weekly limit"));
  }
  if (!fableSeen) {
    rows.push(
      row(
        "fable_week",
        "fable",
        "weekly",
        "Fable",
        remainingFromUsed(body.seven_day_omelette?.utilization),
        body.seven_day_omelette?.resets_at ?? body.seven_day?.resets_at,
      ),
    );
  }
  // Legacy per-family windows: only when the `limits` array did not already carry them.
  const legacy: Array<[keyof ClaudeUsageBody, string, string]> = [
    ["seven_day_opus", "claude_scoped_opus", "Opus"],
    ["seven_day_sonnet", "claude_scoped_sonnet", "Sonnet"],
  ];
  for (const [key, id, label] of legacy) {
    const win = body[key] as ClaudeWindow | undefined;
    if (!win || typeof win.utilization !== "number") continue;
    const family = label.toLowerCase();
    if (rows.some((r) => r.id.startsWith("claude_scoped_") && r.label.toLowerCase().includes(family))) continue;
    rows.push(row(id, "claude", "weekly", label, remainingFromUsed(win.utilization), win.resets_at ?? body.seven_day?.resets_at, "model-scoped weekly limit"));
  }
  return rows;
}

async function fetchCodex(): Promise<RemainingRow[]> {
  const paths = [
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : "",
    join(home, ".codex", "auth.json"),
    join(home, ".config", "codex", "auth.json"),
  ].filter(Boolean);
  let accessToken: string | undefined;
  let accountId: string | undefined;
  for (const path of paths) {
    const auth = await readJson(path);
    const tokens = (auth as { tokens?: { access_token?: string; account_id?: string } } | null)?.tokens;
    if (tokens?.access_token) {
      accessToken = tokens.access_token;
      accountId = tokens.account_id;
      break;
    }
  }
  const fallback = [
    baseRow("codex_session", "codex", "session", "Codex"),
    baseRow("codex_week", "codex", "weekly", "Codex"),
  ];
  if (!accessToken) return fallback;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const res = await fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (res.status === 401 || res.status === 403) return fallback;
  if (!res.ok) throw new Error(`Codex ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("<")) return fallback;
  type CodexWindow = { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
  const body = JSON.parse(text) as {
    rate_limit?: {
      primary_window?: CodexWindow | null;
      secondary_window?: CodexWindow | null;
    };
  };
  const primary = body.rate_limit?.primary_window;
  const secondary = body.rate_limit?.secondary_window;
  const toIso = (epoch: number | undefined) => (epoch != null ? new Date(epoch * 1000).toISOString() : null);
  // Codex window semantics vary by plan; classify by window length when the API
  // reports it, else by reset horizon.
  const windows = [primary, secondary].filter((w): w is CodexWindow => w != null);
  const rows: RemainingRow[] = [];
  for (const w of windows) {
    const iso = toIso(w.reset_at);
    let isSession: boolean;
    if (typeof w.limit_window_seconds === "number") {
      isSession = w.limit_window_seconds <= 6 * 3600;
    } else {
      const hours = iso ? (new Date(iso).getTime() - Date.now()) / 3_600_000 : null;
      isSession = hours != null && hours <= 10;
    }
    const group: Group = isSession ? "session" : "weekly";
    const id = isSession ? "codex_session" : "codex_week";
    if (rows.some((r) => r.id === id)) continue;
    rows.push(row(id, "codex", group, "Codex", remainingFromUsed(w.used_percent), iso));
  }
  if (rows.length === 0) return fallback;
  // Some plans (e.g. Pro as of 2026-09) have only a weekly window; do not invent
  // a session row the endpoint did not report.
  if (!rows.some((r) => r.id === "codex_session")) {
    rows.unshift({ ...baseRow("codex_session", "codex", "session", "Codex"), detail: "no 5-hour window on this plan" });
  }
  return rows;
}

function extractGrokToken(auth: unknown): string | null {
  if (auth == null || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;
  if (typeof record.access_token === "string" && record.access_token) return record.access_token;
  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  for (const [, value] of preferred.length > 0 ? preferred : entries) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
    const key = (value as Record<string, unknown>).key;
    if (typeof key === "string" && key) return key;
  }
  return null;
}

export type GrokBillingBody = {
  config?: {
    monthlyLimit?: { val?: number };
    used?: { val?: number };
    creditUsagePercent?: number;
    currentPeriod?: { type?: string; start?: string; end?: string };
    billingPeriodEnd?: string;
  };
  usage?: { creditUsage?: number };
};

// xAI serialises this body from protobuf: fields at their default value are
// omitted. Right after the weekly reset `creditUsagePercent` is 0 and therefore
// missing, while `currentPeriod` is still present. Treating that as "no data"
// made the Grok row vanish for the whole first hours of every period
// (observed 2026-09-13 after the 18:57 UTC reset). A live period with no usage
// fields means 0 used.
export function parseGrokBilling(body: GrokBillingBody | null | undefined): RemainingRow {
  const config = body?.config;
  if (!config || typeof config !== "object") return baseRow("grok_week", "grok", "weekly", "Grok");
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd ?? null;
  const usedPct = config.creditUsagePercent;
  if (typeof usedPct === "number" && Number.isFinite(usedPct)) {
    return row("grok_week", "grok", "weekly", "Grok", remainingFromUsed(usedPct), periodEnd);
  }
  const limit = config.monthlyLimit?.val ?? null;
  const used = config.used?.val ?? body?.usage?.creditUsage ?? null;
  if (limit != null && limit > 0 && used != null) {
    return row(
      "grok_week",
      "grok",
      "weekly",
      "Grok",
      remainingFromUsed((used / limit) * 100),
      periodEnd,
      `of ${Math.round(limit)} credits`,
    );
  }
  if (periodEnd) {
    return row("grok_week", "grok", "weekly", "Grok", 100, periodEnd, "no usage yet this period");
  }
  return baseRow("grok_week", "grok", "weekly", "Grok");
}

async function fetchGrok(): Promise<RemainingRow> {
  const fallback = baseRow("grok_week", "grok", "weekly", "Grok");
  const token =
    process.env.GROK_API_KEY || process.env.GROK_TOKEN || extractGrokToken(await readJson(join(home, ".grok", "auth.json")));
  if (!token) {
    console.log("[usage-remaining] grok: no token (~/.grok/auth.json missing or unreadable)");
    return fallback;
  }
  const res = await fetchWithTimeout("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    console.log(`[usage-remaining] grok: ${res.status} from billing endpoint`);
    return fallback;
  }
  const parsed = parseGrokBilling((await res.json()) as GrokBillingBody);
  if (parsed.status !== "available") {
    console.log("[usage-remaining] grok: 200 but no usage fields in body (unrecognised shape)");
  }
  return parsed;
}

async function readCursorToken(): Promise<string | null> {
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;
  if (process.env.CURSOR_TOKEN) return process.env.CURSOR_TOKEN;
  const dbPaths = [
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  try {
    const sqlite = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
        prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    for (const path of dbPaths) {
      if (!existsSync(path)) continue;
      let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
      try {
        db = new sqlite.DatabaseSync(path, { readOnly: true });
        const modern = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
        const modernValue = modern?.value;
        if (typeof modernValue === "string" && modernValue.trim()) return modernValue.trim();
        const legacy = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuthStatus");
        if (typeof legacy?.value === "string") {
          const parsed = JSON.parse(legacy.value) as { accessToken?: string };
          if (parsed.accessToken) return parsed.accessToken;
        }
      } finally {
        db?.close();
      }
    }
  } catch {
    // node:sqlite missing or db locked
  }
  for (const path of [join(home, ".cursor", "auth.json"), join(home, ".config", "cursor", "auth.json")]) {
    const auth = await readJson(path);
    const token = (auth as { accessToken?: string } | null)?.accessToken?.trim();
    if (token) return token;
  }
  return null;
}

async function fetchCursor(): Promise<RemainingRow> {
  const token = await readCursorToken();
  if (!token) return baseRow("cursor_month", "cursor", "weekly", "Cursor");
  const res = await fetchWithTimeout("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) return baseRow("cursor_month", "cursor", "weekly", "Cursor");
  const body = (await res.json()) as {
    planUsage?: {
      totalSpend?: number | null;
      limit?: number | null;
      totalPercentUsed?: number | null;
    };
    billingCycleEnd?: string | number | null;
  };
  if (!body.planUsage) return baseRow("cursor_month", "cursor", "weekly", "Cursor");
  let resetIso: string | null = null;
  if (body.billingCycleEnd != null) {
    const numeric = Number(body.billingCycleEnd);
    if (Number.isFinite(numeric)) {
      const ms = Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
      resetIso = new Date(ms).toISOString();
    } else if (typeof body.billingCycleEnd === "string") {
      resetIso = body.billingCycleEnd;
    }
  }
  const usedPct =
    typeof body.planUsage.totalPercentUsed === "number"
      ? body.planUsage.totalPercentUsed
      : body.planUsage.totalSpend != null && body.planUsage.limit
        ? (body.planUsage.totalSpend / body.planUsage.limit) * 100
        : null;
  const detail =
    body.planUsage.totalSpend != null && body.planUsage.limit != null
      ? `used $${Math.round(body.planUsage.totalSpend / 100)} · included $${Math.round(body.planUsage.limit / 100)} · monthly`
      : "monthly";
  return row("cursor_month", "cursor", "weekly", "Cursor", remainingFromUsed(usedPct), resetIso, detail);
}

// Claude Code rotates its OAuth token while agents run; the old token 401s for a
// moment and the rows would flicker out. Serve the last good value instead.
const lastGood = new Map<string, { row: RemainingRow; at: number }>();
const LAST_GOOD_TTL_MS = 6 * 60 * 60_000;
const CLAUDE_META_KEY = "_claude";
const CACHE_PATH = join(process.env.PASEO_HOME || join(home, ".paseo"), "usage-remaining.cache.json");
let cacheLoad: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let cacheWrite = Promise.resolve();

function loadCache(): Promise<void> {
  return cacheLoad ??= readCache();
}

async function readCache(): Promise<void> {
  const raw = await readJson(CACHE_PATH);
  if (raw && typeof raw === "object") {
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (id === CLAUDE_META_KEY) {
        Object.assign(claudeState, restoreClaudeState(entry));
        continue;
      }
      const cached = entry as { row?: RemainingRow; at?: number } | null;
      if (cached && typeof cached.at === "number" && cached.row && cached.row.brand !== "claude" && cached.row.brand !== "fable") lastGood.set(id, { row: cached.row, at: cached.at });
    }
  }
}

function saveCache(): void {
  saveTimer ??= setTimeout(() => { void flushUsageCache(); }, 500);
}

// Plugin reload waits for cleanup, so a just-received 429 cannot be lost by
// stopping the subprocess before the normal debounced cache write runs.
export function flushUsageCache(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!cacheLoad) return cacheWrite;
  cacheWrite = cacheWrite.then(async () => {
    await cacheLoad;
    const obj: Record<string, unknown> = Object.fromEntries(lastGood.entries());
    obj[CLAUDE_META_KEY] = claudeState;
    const temp = `${CACHE_PATH}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(obj), { mode: 0o600 });
    await rename(temp, CACHE_PATH);
  }).catch(() => { console.log("[usage-remaining] cache write failed"); });
  return cacheWrite;
}

// A cached row whose window already reset is worse than no data: it would show
// the pre-reset remaining % next to "now" until the provider API answers again.
function cachedWindowHasReset(cached: RemainingRow, now: number): boolean {
  if (!cached.resetIso) return false;
  const resetMs = new Date(cached.resetIso).getTime();
  return Number.isFinite(resetMs) && resetMs <= now;
}

// A provider that answered recently but is not answering now stays visible as a
// dimmed "—" chip (status "error") instead of silently dropping out of the strip.
// Rows that never had data (not signed in) stay "unavailable" and hidden.
export function withLastGood(
  rows: RemainingRow[],
  now: number = Date.now(),
  cache: Map<string, { row: RemainingRow; at: number }> = lastGood,
): RemainingRow[] {
  let updated = false;
  const merged = rows.map((r) => {
    if (r.status === "available") {
      cache.set(r.id, { row: r, at: now });
      updated = true;
      return r;
    }
    const cached = cache.get(r.id);
    if (cached && now - cached.at <= LAST_GOOD_TTL_MS) {
      if (cachedWindowHasReset(cached.row, now)) {
        return {
          ...r,
          remainingText: "—",
          remainingPct: null,
          resetAt: null,
          resetIso: null,
          tone: "default" as const,
          status: "error" as const,
          detail: "window reset · waiting for provider",
        };
      }
      // Never serve a frozen countdown: recompute it, or drop it when the cached
      // row predates absolute reset timestamps.
      return { ...cached.row, resetAt: cached.row.resetIso ? resetLabel(cached.row.resetIso, now) : null };
    }
    return r;
  });
  if (updated && cache === lastGood) saveCache();
  return merged;
}

function pillText(rows: RemainingRow[]): string {
  return rows.map((r) => `${r.label} ${r.remainingText}`).join(" · ");
}

export async function fetchUsage(input: { force?: boolean; claudeContext?: "workers" | "sundayable-team" } = {}): Promise<UsageSnapshot> {
  await loadCache();
  const [claude, codex, grok, cursor] = await Promise.allSettled([
    input.claudeContext === "sundayable-team" ? fetchClaudeTeam() : fetchClaude(),
    fetchCodex(),
    fetchGrok(),
    input.claudeContext === "sundayable-team" ? Promise.resolve(null) : fetchCursor(),
  ]);
  for (const [name, result] of [["claude", claude], ["codex", codex], ["grok", grok], ["cursor", cursor]] as const) {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.log(`[usage-remaining] ${name}: fetch failed (${reason})`);
    }
  }
  const rows: RemainingRow[] = [];
  rows.push(...(claude.status === "fulfilled" ? claude.value : claudeFallbackRows()).map(row => input.claudeContext === "sundayable-team" ? { ...row, accountScope: "sundayable-team" as const, label: row.brand === "fable" ? "Fable · Sundayable Team" : "Claude · Sundayable Team" } : row));
  rows.push(...(codex.status === "fulfilled" ? codex.value : [
    baseRow("codex_session", "codex", "session", "Codex"),
    baseRow("codex_week", "codex", "weekly", "Codex"),
  ]));
  rows.push(grok.status === "fulfilled" ? grok.value : baseRow("grok_week", "grok", "weekly", "Grok"));
  if (input.claudeContext !== "sundayable-team") rows.push(cursor.status === "fulfilled" && cursor.value ? cursor.value : baseRow("cursor_month", "cursor", "weekly", "Cursor"));

  // Claude samples are credential-bound and retain their original observation time.
  // Never let the provider-wide cache reintroduce a different account's rows.
  const merged = [
    ...rows.filter((r) => r.brand === "claude" || r.brand === "fable").map((r) => ({ ...r, resetAt: resetLabel(r.resetIso) })),
    ...withLastGood(rows.filter((r) => r.brand !== "claude" && r.brand !== "fable")),
  ];
  const session = merged.filter((r) => r.group === "session");
  const weekly = merged.filter((r) => r.group === "weekly");
  return {
    fetchedAt: new Date().toISOString(),
    pillText: `5h ${pillText(session)} | wk ${pillText(weekly)}`,
    rows: [...session, ...weekly],
  };
}
