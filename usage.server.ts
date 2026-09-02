import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RemainingRow, UsageSnapshot } from "./usage.shared";

const execFileAsync = promisify(execFile);
const home = homedir();

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

function resetLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const delta = date.getTime() - Date.now();
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
    detail: "unavailable",
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

// Anthropic rate-limits the usage endpoint hard for setup tokens; remember cooldowns
// per token so one 429 does not burn every refresh cycle.
const tokenCooldownUntil = new Map<string, number>();
let lastClaudeRows: RemainingRow[] | null = null;
let lastClaudeAt = 0;
const CLAUDE_MIN_INTERVAL_MS = 120_000;

async function readClaudeEnvToken(): Promise<string | undefined> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Optional env files some setups use to hand Claude a long-lived token.
  for (const path of [
    join(home, ".config", "agent-core", "auth", "claude.env"),
    join(home, ".claude", "claude.env"),
  ]) {
    try {
      const env = await readFile(path, "utf8");
      const token = env.match(/CLAUDE_CODE_OAUTH_TOKEN=["']?([^"'\n]+)/)?.[1];
      if (token) return token;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

async function fetchClaude(force = false): Promise<RemainingRow[]> {
  const now = Date.now();
  if (
    !force &&
    lastClaudeRows &&
    now - lastClaudeAt < CLAUDE_MIN_INTERVAL_MS &&
    !lastClaudeRows.some((r) => cachedWindowHasReset(r, now))
  ) {
    return lastClaudeRows;
  }
  const tokens: string[] = [];
  const seen = new Set<string>();
  const addToken = (token: string | undefined) => {
    if (token && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  };
  const account = /^[a-zA-Z0-9._-]+$/.test(process.env.USER || userInfo().username)
    ? process.env.USER || userInfo().username
    : "claude-code-user";
  for (const args of [
    ["find-generic-password", "-a", account, "-w", "-s", "Claude Code-credentials"],
    ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
  ]) {
    try {
      const { stdout } = await execFileAsync("security", args, { timeout: 2000 });
      const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: string } };
      addToken(parsed.claudeAiOauth?.accessToken);
    } catch {
      // keep looking
    }
  }
  const file = await readJson(join(process.env.CLAUDE_HOME || join(home, ".claude"), ".credentials.json"));
  addToken((file as { claudeAiOauth?: { accessToken?: string } } | null)?.claudeAiOauth?.accessToken);
  // Paseo agents authenticate through this long-lived token; keep it as the last resort.
  addToken(await readClaudeEnvToken());

  const fallback = [
    baseRow("claude_session", "claude", "session", "Claude"),
    baseRow("claude_week", "claude", "weekly", "Claude"),
    baseRow("fable_week", "fable", "weekly", "Fable"),
  ];
  if (tokens.length === 0) return fallback;

  type ClaudeUsageBody = {
    five_hour?: { utilization?: number; resets_at?: string | null };
    seven_day?: { utilization?: number; resets_at?: string | null };
    seven_day_omelette?: { utilization?: number; resets_at?: string | null };
    limits?: Array<{
      kind?: string;
      percent?: number;
      resets_at?: string | null;
      scope?: { model?: { display_name?: string | null; id?: string | null } | null };
    }>;
  };
  let body: ClaudeUsageBody | null = null;
  for (const token of tokens) {
    const cooldown = tokenCooldownUntil.get(token);
    if (cooldown && now < cooldown) continue;
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (res.status === 401 || res.status === 403) continue;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3_600_000;
      tokenCooldownUntil.set(token, now + waitMs);
      continue;
    }
    if (!res.ok) continue;
    body = (await res.json()) as ClaudeUsageBody;
    break;
  }
  if (!body) return fallback;

  const fableLimit = body.limits?.find((entry) => {
    if (entry.kind !== "weekly_scoped") return false;
    const name = `${entry.scope?.model?.display_name ?? ""} ${entry.scope?.model?.id ?? ""}`.toLowerCase();
    return name.includes("fable") || name.includes("omelette");
  });
  const fableUsed = fableLimit?.percent ?? body.seven_day_omelette?.utilization;
  const fableReset = fableLimit?.resets_at ?? body.seven_day_omelette?.resets_at ?? body.seven_day?.resets_at;

  const rows = [
    row("claude_session", "claude", "session", "Claude", remainingFromUsed(body.five_hour?.utilization), body.five_hour?.resets_at),
    row("claude_week", "claude", "weekly", "Claude", remainingFromUsed(body.seven_day?.utilization), body.seven_day?.resets_at),
    row("fable_week", "fable", "weekly", "Fable", remainingFromUsed(fableUsed), fableReset),
  ];
  lastClaudeRows = rows;
  lastClaudeAt = Date.now();
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
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
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
  // The endpoint omits the 5-hour window entirely while it is unused, so a
  // weekly-only answer means the session window is full.
  if (rows.some((r) => r.id === "codex_week") && !rows.some((r) => r.id === "codex_session")) {
    rows.unshift(row("codex_session", "codex", "session", "Codex", 100, null, "unused"));
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

async function fetchGrok(): Promise<RemainingRow> {
  const token =
    process.env.GROK_API_KEY || process.env.GROK_TOKEN || extractGrokToken(await readJson(join(home, ".grok", "auth.json")));
  if (!token) return baseRow("grok_week", "grok", "weekly", "Grok");
  const res = await fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
      Accept: "application/json",
    },
  });
  if (!res.ok) return baseRow("grok_week", "grok", "weekly", "Grok");
  const body = (await res.json()) as {
    config?: {
      monthlyLimit?: { val?: number };
      used?: { val?: number };
      creditUsagePercent?: number;
      currentPeriod?: { type?: string; end?: string };
    };
    usage?: { creditUsage?: number };
  };
  const usedPct = body.config?.creditUsagePercent;
  if (typeof usedPct === "number") {
    return row("grok_week", "grok", "weekly", "Grok", remainingFromUsed(usedPct), body.config?.currentPeriod?.end);
  }
  const limit = body.config?.monthlyLimit?.val ?? null;
  const used = body.config?.used?.val ?? body.usage?.creditUsage ?? null;
  if (limit == null || used == null || limit <= 0) return baseRow("grok_week", "grok", "weekly", "Grok");
  return row(
    "grok_week",
    "grok",
    "weekly",
    "Grok",
    remainingFromUsed((used / limit) * 100),
    body.config?.currentPeriod?.end,
    `of ${Math.round(limit)} credits`,
  );
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
  const res = await fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
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
const CACHE_PATH = join(process.env.PASEO_HOME || join(home, ".paseo"), "usage-remaining.cache.json");
let cacheLoaded = false;
let savePending = false;

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const raw = await readJson(CACHE_PATH);
  if (raw && typeof raw === "object") {
    for (const [id, entry] of Object.entries(raw as Record<string, { row: RemainingRow; at: number }>)) {
      if (entry && typeof entry.at === "number" && entry.row) lastGood.set(id, entry);
    }
  }
}

function saveCache(): void {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    const obj = Object.fromEntries(lastGood.entries());
    void writeFile(CACHE_PATH, JSON.stringify(obj)).catch(() => undefined);
  }, 500);
}

// A cached row whose window already reset is worse than no data: it would show
// the pre-reset remaining % next to "now" until the provider API answers again.
function cachedWindowHasReset(cached: RemainingRow, now: number): boolean {
  if (!cached.resetIso) return false;
  const resetMs = new Date(cached.resetIso).getTime();
  return Number.isFinite(resetMs) && resetMs <= now;
}

function withLastGood(rows: RemainingRow[]): RemainingRow[] {
  const now = Date.now();
  let updated = false;
  const merged = rows.map((r) => {
    if (r.status === "available") {
      lastGood.set(r.id, { row: r, at: now });
      updated = true;
      return r;
    }
    const cached = lastGood.get(r.id);
    if (cached && now - cached.at <= LAST_GOOD_TTL_MS && !cachedWindowHasReset(cached.row, now)) {
      return { ...cached.row };
    }
    return r;
  });
  if (updated) saveCache();
  return merged;
}

function pillText(rows: RemainingRow[]): string {
  return rows.map((r) => `${r.label} ${r.remainingText}`).join(" · ");
}

export async function fetchUsage(input: { force?: boolean } = {}): Promise<UsageSnapshot> {
  await loadCache();
  const [claude, codex, grok, cursor] = await Promise.allSettled([
    fetchClaude(input.force === true),
    fetchCodex(),
    fetchGrok(),
    fetchCursor(),
  ]);
  const rows: RemainingRow[] = [];
  rows.push(...(claude.status === "fulfilled" ? claude.value : [
    baseRow("claude_session", "claude", "session", "Claude"),
    baseRow("claude_week", "claude", "weekly", "Claude"),
    baseRow("fable_week", "fable", "weekly", "Fable"),
  ]));
  rows.push(...(codex.status === "fulfilled" ? codex.value : [
    baseRow("codex_session", "codex", "session", "Codex"),
    baseRow("codex_week", "codex", "weekly", "Codex"),
  ]));
  rows.push(grok.status === "fulfilled" ? grok.value : baseRow("grok_week", "grok", "weekly", "Grok"));
  rows.push(cursor.status === "fulfilled" ? cursor.value : baseRow("cursor_month", "cursor", "weekly", "Cursor"));

  const merged = withLastGood(rows).map((r) =>
    r.resetIso ? { ...r, resetAt: resetLabel(r.resetIso) } : r,
  );
  const session = merged.filter((r) => r.group === "session");
  const weekly = merged.filter((r) => r.group === "weekly");
  return {
    fetchedAt: new Date().toISOString(),
    pillText: `5h ${pillText(session)} | wk ${pillText(weekly)}`,
    rows: [...session, ...weekly],
  };
}
