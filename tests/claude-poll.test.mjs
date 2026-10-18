import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudePoller, credentialKey, emptyClaudeState, restoreClaudeState, retryDelay } from "../server/claude-poll.ts";
import { parseClaudeUsage, parseClaudeHeaders, claudeSignedOutRows, readClaudeEnvToken } from "../server/usage.ts";
import { usageLabel } from "../client/registry.ts";

const START = Date.parse("2026-10-18T18:00:00Z");
const worker = { source: "env", token: "fixture-worker", expiresAt: null, description: "claude.env" };
const personal = { source: "keychain", token: "fixture-personal", expiresAt: null, description: "Claude max" };
const body = (used = 13, at = START) => ({
  five_hour: { utilization: used, resets_at: new Date(at + 3600_000).toISOString() },
  seven_day: { utilization: used + 10, resets_at: new Date(at + 86400_000).toISOString() },
});
const ok = (used = 13) => new Response(JSON.stringify(body(used)), { status: 200 });

function fixture(options = {}) {
  let at = START;
  let creds = options.creds ?? [personal, worker];
  const requests = [], probes = [], logs = [];
  const state = options.state ?? emptyClaudeState();
  const poll = createClaudePoller({
    readCredentials: async () => ({ creds, loginRecord: true }),
    request: async token => { requests.push(token); return options.request ? options.request(token) : ok(); },
    headerProbe: options.probe ? { request: async token => { probes.push(token); return options.probe(token); }, parse: parseClaudeHeaders } : undefined,
    persist: options.persist,
    parse: parseClaudeUsage,
    fallback: () => parseClaudeUsage({}),
    signedOut: claudeSignedOutRows,
    state, now: () => at, changed() {}, log: msg => logs.push(msg),
  });
  return { poll, state, requests, probes, logs, advance: ms => { at += ms; }, select: value => { creds = value; } };
}

const headerResponse = (session = "0.13", weekly, status = 200, extra = {}) => new Response(null, { status, headers: {
  "anthropic-ratelimit-unified-5h-utilization": session,
  "anthropic-ratelimit-unified-5h-reset": String((START + 3600_000) / 1000),
  ...(weekly == null ? {} : { "anthropic-ratelimit-unified-7d-utilization": weekly, "anthropic-ratelimit-unified-7d-reset": String((START + 86400_000) / 1000) }),
  ...extra,
} });

test("Haiku headers report worker session and explicitly unknown week, never personal 100%", async () => {
  const f = fixture({ request: () => new Response(null, { status: 429 }), probe: () => headerResponse() });
  const rows = await f.poll();
  assert.deepEqual(f.requests, [worker.token]);
  assert.deepEqual(f.probes, [worker.token]);
  assert.equal(rows[0].remainingText, "87%");
  assert.equal(rows[1].remainingPct, null);
  assert.equal(rows[1].remainingText, "unknown");
  assert.equal(usageLabel("claude", { rows }), "Claude (workers) · 5H 87% · WK unknown");
  assert.match(rows[0].detail, /worker token.*429.*Haiku response headers/);
  assert.ok(!JSON.stringify([rows, f.state, f.logs]).includes(worker.token));
});

test("header parser handles weekly zero, over-limit fractions and invalid/missing values without inventing usage", () => {
  assert.deepEqual(parseClaudeHeaders(headerResponse("0.2", "0").headers).map(r => r.remainingPct), [80, 100]);
  assert.equal(parseClaudeHeaders(headerResponse("1.25", "0.4").headers)[0].remainingPct, 0);
  assert.equal(parseClaudeHeaders(headerResponse("0.2", "0.4").headers)[1].resetIso, new Date(START + 86400_000).toISOString());
  for (const value of ["", " ", "bad", "Infinity", "-0.1"]) {
    const rows = parseClaudeHeaders(headerResponse(value).headers);
    assert.equal(rows[0].remainingPct, null);
    assert.equal(rows[0].status, "error");
  }
});

test("probe attempts are persisted before sending, share single-flight, and survive reloads at the five-minute boundary", async () => {
  const key = credentialKey(worker.token);
  let persisted = false;
  const f = fixture({ request: () => new Response(null, { status: 429 }), persist: async () => { persisted = true; }, probe: () => { assert.ok(persisted); return headerResponse(); } });
  await Promise.all([f.poll(), f.poll(), f.poll()]);
  assert.equal(f.probes.length, 1);
  assert.equal(f.state.headerAttempts[key], START);
  const reloaded = fixture({ state: restoreClaudeState(JSON.parse(JSON.stringify(f.state)), START), probe: () => headerResponse("0.2") });
  await reloaded.poll();
  reloaded.advance(299_999);
  await reloaded.poll();
  assert.equal(reloaded.probes.length, 0);
  reloaded.advance(1);
  assert.equal((await reloaded.poll())[0].remainingText, "80%");
  assert.deepEqual(reloaded.requests, []);
  assert.equal(reloaded.probes.length, 1);
});

test("healthy usage API and keychain-only accounts never generate inference requests", async () => {
  for (const creds of [[worker, personal], [personal]]) {
    const f = fixture({ creds, probe: () => { throw Error("must not probe"); } });
    await f.poll();
    assert.equal(f.probes.length, 0);
  }
});

test("header samples replace stale worker weekly values and never cross credential changes", async () => {
  let fail = false;
  const f = fixture({ creds: [worker], request: () => fail ? new Response(null, { status: 403 }) : ok(), probe: token => token === worker.token ? headerResponse("0.2") : new Response(null, { status: 401 }) });
  await f.poll();
  fail = true;
  f.advance(300_000);
  const rows = await f.poll();
  assert.equal(rows[0].remainingText, "80%");
  assert.equal(rows[1].remainingText, "unknown");
  f.select([{ ...worker, token: "fixture-worker-new" }]);
  assert.equal((await f.poll())[0].remainingPct, null);
});

test("probe failures are bounded, keep safe diagnostics, and respect their own retry-after/auth cooldown", async () => {
  for (const status of [429, 403, 401, 500, 0]) {
    const f = fixture({ creds: [worker], request: () => new Response(null, { status: 429 }), probe: () => {
      if (!status) throw Error(worker.token);
      return new Response(worker.token, { status, headers: { "retry-after": "600" } });
    } });
    await f.poll();
    await f.poll();
    assert.equal(f.probes.length, 1);
    f.advance(300_000);
    await f.poll();
    assert.equal(f.probes.length, [429, 403, 401].includes(status) ? 1 : 2);
    assert.ok(!JSON.stringify([f.state, f.logs]).includes(worker.token));
  }
});

test("a quota-rejected probe can supply real headers while respecting retry-after", async () => {
  const f = fixture({ request: () => new Response(null, { status: 429 }), probe: () => headerResponse("1", "0.5", 429, { "retry-after": "3600" }) });
  const rows = await f.poll();
  assert.equal(rows[0].remainingPct, 0);
  assert.equal(rows[1].remainingPct, 50);
  f.advance(300_000);
  await f.poll();
  assert.equal(f.probes.length, 1);
});

test("worker token wins over an idle personal keychain account, with source in the chip", async () => {
  const f = fixture({ request: token => token === worker.token ? ok(13) : ok(0) });
  const rows = await f.poll();
  assert.deepEqual(f.requests, [worker.token]);
  assert.equal(rows[0].remainingText, "87%");
  assert.equal(usageLabel("claude", { rows }), "Claude (workers) · 5H 87% · WK 77%");
  assert.match(rows[0].detail, /worker token.*claude.env/);
});

test("403 uses an explicitly labelled keychain fallback and preserves the six-hour cooldown", async () => {
  const f = fixture({ request: token => token === worker.token ? new Response(null, { status: 403 }) : ok(0) });
  const rows = await f.poll();
  assert.deepEqual(f.requests, [worker.token, personal.token]);
  assert.equal(rows[0].label, "Claude (fallback)");
  assert.match(rows[0].detail, /keychain fallback.*different account.*Claude max.*worker usage unavailable.*403/);
  assert.match(usageLabel("claude", { rows }), /fallback/);
  assert.equal(f.state.tokenCooldowns[credentialKey(worker.token)], START + 6 * 3600_000);
  f.advance(300_000);
  await f.poll();
  assert.deepEqual(f.requests, [worker.token, personal.token, personal.token]);
});

test("429 cooldown and five-minute attempts survive reloads and repeated manual refreshes", async () => {
  const f = fixture({ request: token => token === worker.token ? new Response(null, { status: 429, headers: { "retry-after": "3600" } }) : ok(0) });
  await f.poll();
  const restored = restoreClaudeState(JSON.parse(JSON.stringify(f.state)), START);
  const reloaded = fixture({ state: restored });
  await reloaded.poll();
  await reloaded.poll();
  assert.equal(reloaded.requests.length, 0);
  reloaded.advance(3600_000);
  assert.equal((await reloaded.poll())[0].label, "Claude (workers)");
  assert.deepEqual(reloaded.requests, [worker.token]);
});

test("403 scope diagnostics retain only fixed text, never provider bodies or echoed credentials", async () => {
  const f = fixture({ creds: [worker], request: () => new Response(JSON.stringify({ error: { message: `Token ${worker.token} is missing required user:profile scope` } }), { status: 403 }) });
  const rows = await f.poll();
  assert.match(rows[0].detail, /missing user:profile scope/);
  const restored = restoreClaudeState(JSON.parse(JSON.stringify(f.state)), START);
  assert.equal(restored.errors[credentialKey(worker.token)], "HTTP 403 (missing user:profile scope)");
  for (const output of [rows, f.state, f.logs]) assert.ok(!JSON.stringify(output).includes(worker.token));
});

test("legacy cooldowns migrate, but unscoped legacy rows are never worker samples", () => {
  const key = credentialKey(worker.token);
  const state = restoreClaudeState({ tokenCooldowns: { [key]: START + 3600_000 }, lastAt: START, claude_session: { row: { remainingText: "100%" }, at: START } }, START);
  assert.equal(state.tokenCooldowns[key], START + 3600_000);
  assert.deepEqual(state.samples, {});
});

test("retry-after supports seconds, dates, and a one-hour default", () => {
  assert.equal(retryDelay("120", START), 120_000);
  assert.equal(retryDelay(new Date(START + 3600_000).toUTCString(), START), 3600_000);
  for (const value of [null, "bad", "-1", "0"]) assert.equal(retryDelay(value, START), 3600_000);
});

test("concurrent callers share one request, and successful reads are limited to five minutes", async () => {
  let resolve;
  const response = new Promise(r => { resolve = r; });
  const f = fixture({ request: () => response });
  const a = f.poll(), b = f.poll();
  assert.equal(a, b);
  resolve(ok());
  await Promise.all([a, b]);
  await f.poll();
  f.advance(299_999);
  await f.poll();
  assert.deepEqual(f.requests, [worker.token]);
});

test("failed network/401/500 attempts cannot be retried on each UI refresh", async () => {
  for (const status of [401, 500, 0]) {
    const f = fixture({ creds: [worker], request: () => { if (!status) throw Error(worker.token); return new Response(null, { status }); } });
    await f.poll();
    await f.poll();
    assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(f.logs).includes(worker.token));
    f.advance(300_000);
    await f.poll();
    assert.equal(f.requests.length, 2);
  }
});

test("switching worker credentials cannot return the previous worker's cached percentages", async () => {
  const f = fixture({ creds: [worker], request: token => token === worker.token ? ok(13) : new Response(null, { status: 403 }) });
  await f.poll();
  f.select([{ ...worker, token: "fixture-other-worker" }]);
  const rows = await f.poll();
  assert.equal(rows[0].remainingPct, null);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].remainingText, "unavailable");
  assert.match(rows[0].detail, /403/);
});

test("a restored keychain sample stays fallback while workers cool down", async () => {
  const key = credentialKey(worker.token), fallback = credentialKey(personal.token);
  const state = emptyClaudeState();
  state.tokenCooldowns[key] = START + 3600_000;
  state.lastAttempts[fallback] = START;
  state.samples[fallback] = { rows: parseClaudeUsage(body(0)), at: START };
  const f = fixture({ state });
  const rows = await f.poll();
  assert.equal(f.requests.length, 0);
  assert.equal(rows[0].label, "Claude (fallback)");
  assert.match(rows[0].detail, /worker usage unavailable.*retry after/);
});

test("a good worker sample is preferred to a different account on failure, without renewing its age", async () => {
  let fail = false;
  const f = fixture({ request: () => fail ? new Response(null, { status: 429 }) : ok() });
  await f.poll();
  fail = true;
  f.advance(300_000);
  const rows = await f.poll();
  assert.equal(rows[0].remainingText, "87%");
  assert.equal(rows[0].label, "Claude (workers)");
  assert.match(rows[0].detail, /cached usage.*429/);
  assert.equal(f.state.samples[credentialKey(worker.token)].at, START);
  assert.ok(f.requests.every(token => token === worker.token));
  f.advance(3600_000);
  const reset = await f.poll();
  assert.equal(reset[0].remainingPct, null);
  assert.equal(reset[1].remainingText, "77%");
});

test("expired samples are dropped after six hours even across reloads", () => {
  const state = emptyClaudeState();
  state.samples[credentialKey(worker.token)] = { rows: parseClaudeUsage(body()), at: START };
  assert.deepEqual(restoreClaudeState(state, START + 6 * 3600_000 + 1).samples, {});
});

test("an expired personal login does not make an authenticated worker look signed out", async () => {
  const f = fixture({ creds: [worker, { ...personal, expiresAt: START - 1 }], request: () => new Response(null, { status: 403 }) });
  const rows = await f.poll();
  assert.equal(rows[0].remainingText, "unavailable");
  assert.match(rows[0].detail, /worker usage unavailable/);
  assert.deepEqual(f.requests, [worker.token]);
  const signedOut = fixture({ creds: [{ ...personal, expiresAt: START - 1 }] });
  assert.equal((await signedOut.poll())[0].remainingText, "login expired");
});

test("credential deduplication uses worker provenance even if keychain has the same token", async () => {
  const f = fixture({ creds: [{ ...personal, token: worker.token }, worker] });
  assert.equal((await f.poll())[0].label, "Claude (workers)");
  assert.equal(f.requests.length, 1);
});

test("claude.env takes precedence over the daemon environment; literal quoting/comments are parsed safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-source-test-"));
  const dir = join(root, ".config", "agent-core", "auth");
  try {
    await mkdir(dir, { recursive: true });
    assert.equal((await readClaudeEnvToken(root, "fixture-inherited")).token, "fixture-inherited");
    for (const assignment of ["export CLAUDE_CODE_OAUTH_TOKEN='fixture-file' # worker", 'CLAUDE_CODE_OAUTH_TOKEN="fixture-file"', "CLAUDE_CODE_OAUTH_TOKEN=fixture-file"]) {
      await writeFile(join(dir, "claude.env"), assignment + "\n");
      assert.equal((await readClaudeEnvToken(root, "fixture-inherited")).token, "fixture-file");
    }
    await mkdir(join(root, ".paseo"));
    await writeFile(join(root, ".paseo", "usage-remaining.accounts.json"), JSON.stringify({ [credentialKey("fixture-file")]: "Team fixture" }));
    assert.match((await readClaudeEnvToken(root)).description, /Team fixture/);
    await writeFile(join(dir, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=fixture-changed\n");
    assert.ok(!(await readClaudeEnvToken(root)).description.includes("Team fixture"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state persistence contains only credential digests, never raw credential values", async () => {
  const f = fixture();
  await f.poll();
  for (const token of [worker.token, personal.token]) {
    assert.ok(!JSON.stringify(f.state).includes(token));
    assert.ok(!JSON.stringify(f.logs).includes(token));
  }
});
