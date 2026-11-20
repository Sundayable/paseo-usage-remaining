/** Official agy statusLine JSON, never private endpoints or token-derived estimates.
 * https://antigravity.google/docs/cli/statusline
 * macOS collector opens its own idle terminal CLI; it never sends a prompt.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RemainingRow } from "../shared/usage";

const WINDOWS = [["gemini_session", "gemini-5h", "session"], ["gemini_week", "gemini-weekly", "weekly"]] as const;
const INTERVAL_MS = 5 * 60_000;
const TTL_MS = 10 * 60_000;
const KEY_ENV = ["GEMINI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA", "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS"];
function record(v: unknown): Record<string, unknown> | null { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }

export function parseGeminiStatus(raw: unknown, now = Date.now()): RemainingRow[] {
  const data = record(raw);
  const at = data?.observedAt;
  const valid = data?.product === "antigravity" && data.plan_tier === "Google AI Pro"
    && typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now && now - at <= TTL_MS;
  return WINDOWS.map(([id, bucket, group]) => {
    const value = valid ? record(record(data?.quota)?.[bucket]) : null;
    const fraction = value?.remaining_fraction;
    const reset = value?.reset_time;
    const resetMs = typeof reset === "string" ? Date.parse(reset) : NaN;
    const available = value?.disabled !== true && typeof fraction === "number" && Number.isFinite(fraction)
      && fraction >= 0 && fraction <= 1 && Number.isFinite(resetMs) && resetMs > now;
    const pct = available ? Math.round(fraction * 1000) / 10 : null;
    return { id, brand: "gemini", group, label: "Gemini · Google AI Pro", remainingPct: pct,
      remainingText: pct === null ? "—" : `${pct}%`, resetAt: available ? `${Math.max(1, Math.ceil((resetMs - now) / 60000))}m` : null,
      resetIso: available ? new Date(resetMs).toISOString() : null,
      observedAt: valid ? at as number : null,
      detail: available ? "Official agy subscription quota · shared Gemini bucket" : "Official agy quota unavailable · no estimate",
      tone: pct === null ? "default" : pct > 50 ? "ok" : pct > 20 ? "warning" : "danger",
      status: available ? "available" : "unavailable" };
  });
}

/** Only an explicit allowlist reaches disk. Identity, transcript and auth are discarded. */
const CAPTURE = `const fs=require('node:fs');let s='';process.stdin.on('data',x=>{s+=x;if(s.length>1048576)process.exit(1)});process.stdin.on('end',()=>{try{const d=JSON.parse(s),q={};for(const k of ['gemini-5h','gemini-weekly']){const b=d.quota?.[k];if(b)q[k]={remaining_fraction:b.remaining_fraction,reset_time:b.reset_time,disabled:b.disabled};}const out={product:d.product,plan_tier:d.plan_tier,quota:q,observedAt:Date.now()};const p=process.argv[2];fs.writeFileSync(p+'.tmp',JSON.stringify(out),{mode:0o600});fs.renameSync(p+'.tmp',p)}catch{}});`;
// Standard-library PTY owner: no terminal-input forwarding, output is drained/discarded.
// pty.fork gives agy its own controlling terminal. The supervisor owns and reaps it.
const PTY_OWNER = `import os,pty,signal,sys,time,select
stop=False
def halt(*args):
 global stop
 stop=True
signal.signal(signal.SIGTERM,halt)
signal.signal(signal.SIGINT,halt)
pid,fd=pty.fork()
if pid==0:
 os.execv(sys.argv[1],[sys.argv[1],'--settings',sys.argv[2]])
end=time.monotonic()+13
reaped=False
try:
 while not stop and time.monotonic()<end:
  done,_=os.waitpid(pid,os.WNOHANG)
  if done:
   reaped=True
   break
  ready,_,_=select.select([fd],[],[],0.1)
  if ready:
   try: os.read(fd,65536)
   except OSError: break
finally:
 if not reaped:
  try: os.killpg(pid,signal.SIGTERM)
  except ProcessLookupError: pass
  time.sleep(0.2)
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
  try: os.waitpid(pid,0)
  except ChildProcessError: pass
 os.close(fd)
`;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export async function collectGeminiStatus(): Promise<unknown> {
  if (process.platform !== "darwin") return null;
  const dir = await mkdtemp(join(tmpdir(), "paseo-gemini-quota-"));
  const capture = join(dir, "capture.cjs"), snapshot = join(dir, "quota.json"), supervisor = join(dir, "terminal-owner.py");
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> = Promise.resolve();
  let exited = false;
  try {
    await writeFile(capture, CAPTURE, { mode: 0o600 });
    await writeFile(supervisor, PTY_OWNER, { mode: 0o600 });
    // Never launch a browser/interactive sign-in from a background quota read.
    await writeFile(join(dir, "open"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0",
      BROWSER: "/usr/bin/false", PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    for (const key of KEY_ENV) delete env[key];
    const settings = { modelProvider: "", useG1Credits: false,
      statusLine: { type: "command", command: `${quote(process.execPath)} ${quote(capture)} ${quote(snapshot)}` } };
    // A private PTY supplies the documented statusLine callback, never screen scraping.
    child = spawn("/usr/bin/python3", [supervisor, join(homedir(), ".local/bin/agy"), JSON.stringify(settings)],
      { cwd: dir, env, detached: true, stdio: ["pipe", "ignore", "ignore"] });
    closed = new Promise<void>(resolve => { child!.once("error", () => { exited = true; resolve(); }); child!.once("close", () => { exited = true; resolve(); }); });
    const deadline = Date.now() + 12_000;
    let latest: unknown = null;
    while (!exited && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { latest = JSON.parse(await readFile(snapshot, "utf8")); } catch { continue; }
      if (parseGeminiStatus(latest).every(row => row.status === "available")) return latest;
    }
    return latest;
  } finally {
    // The process group belongs exclusively to this probe, never the serving seat.
    if (child?.pid && !exited) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already closed */ }
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1500))]);
      if (!exited) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already closed */ }
      }
      await closed;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

export function createGeminiPoller(collect: () => Promise<unknown> = collectGeminiStatus, clock = Date.now) {
  let lastAttempt: number | null = null;
  let sample: unknown = null;
  let inFlight: Promise<RemainingRow[]> | null = null;
  return async (): Promise<RemainingRow[]> => {
    if (inFlight) return inFlight;
    const now = clock();
    if (lastAttempt !== null && now - lastAttempt < INTERVAL_MS) return parseGeminiStatus(sample, now);
    lastAttempt = now;
    inFlight = (async () => {
      // Failed/auth-expired probes invalidate the old account's values immediately.
      try { sample = await collect(); } catch { sample = null; }
      return parseGeminiStatus(sample, clock());
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}
export const fetchGemini = createGeminiPoller();
