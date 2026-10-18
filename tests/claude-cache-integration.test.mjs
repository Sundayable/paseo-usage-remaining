import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const usageUrl = new URL("../server/usage.ts", import.meta.url).href;

test("real cache adapter drops legacy account rows, isolates account switches, and preserves cooldowns across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-cache-integration-"));
  const auth = join(root, ".config/agent-core/auth");
  const paseo = join(root, ".paseo");
  const bin = join(root, "bin");
  const cachePath = join(paseo, "usage-remaining.cache.json");
  try {
    await Promise.all([mkdir(auth, { recursive: true }), mkdir(paseo), mkdir(bin)]);
    // Child processes can only see fixture credentials, never the real keychain.
    await writeFile(join(bin, "security"), '#!/bin/sh\nprintf \'%s\\n\' \'{"claudeAiOauth":{"accessToken":"fixture-keychain","subscriptionType":"max"}}\'\n', { mode: 0o700 });
    await writeFile(join(auth, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=fixture-worker-one\n");
    await writeFile(cachePath, JSON.stringify({ claude_session: { at: Date.now(), row: { id: "claude_session", brand: "claude", status: "available", remainingPct: 100, remainingText: "100%" } } }));
    const script = `
      import { fetchUsage, flushUsageCache } from ${JSON.stringify(usageUrl)};
      const calls = [];
      globalThis.fetch = async (url, init) => {
        if (url === 'https://api.anthropic.com/v1/messages') {
          const body = JSON.parse(init.body);
          if (body.model !== 'claude-haiku-4-5-20251001' || body.max_tokens !== 1 || body.messages[0].content !== '.' || init.headers.Authorization !== 'Bearer fixture-worker-two') throw Error('unexpected probe configuration');
          calls.push('header');
          return new Response(null, { headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now()/1000)+3600) } });
        }
        if (url !== 'https://api.anthropic.com/api/oauth/usage') throw Error('unexpected request');
        const token = init.headers.Authorization.slice(7);
        calls.push(token === 'fixture-keychain' ? 'keychain' : 'worker');
        if (token === 'fixture-worker-two') return new Response(null, { status: 429, headers: { 'retry-after': '3600' } });
        const used = token === 'fixture-keychain' ? 0 : 13;
        return new Response(JSON.stringify({
          five_hour: { utilization: used, resets_at: new Date(Date.now()+3600000).toISOString() },
          seven_day: { utilization: used, resets_at: new Date(Date.now()+86400000).toISOString() }
        }));
      };
      const [first, second] = await Promise.all([fetchUsage({force:true}),fetchUsage({force:true})]);
      await flushUsageCache();
      console.log('RESULT:' + JSON.stringify({ calls, first: first.rows.find(r=>r.id==='claude_session'), second: second.rows.find(r=>r.id==='claude_session') }));
    `;
    const child = async () => {
      const result = await run(process.execPath, ["--input-type=module", "-e", script], {
        cwd: dirname(fileURLToPath(import.meta.url)),
        env: { HOME: root, PATH: `${bin}:${process.env.PATH}`, USER: "fixture", PASEO_HOME: paseo },
        timeout: 10_000,
      });
      return JSON.parse(result.stdout.split("\n").find(line => line.startsWith("RESULT:")).slice(7));
    };
    const first = await child();
    assert.deepEqual(first.calls, ["worker"]);
    assert.equal(first.first.remainingText, "87%");
    assert.equal(first.second.label, "Claude (workers)");

    await writeFile(join(auth, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=fixture-worker-two\n");
    const switched = await child();
    assert.deepEqual(switched.calls, ["worker", "header"]);
    assert.equal(switched.first.label, "Claude (workers)");
    assert.equal(switched.first.remainingText, "75%");
    assert.match(switched.first.detail, /429.*Haiku response headers/);

    const reloaded = await child();
    assert.deepEqual(reloaded.calls, []);
    assert.equal(reloaded.first.label, "Claude (workers)");
    assert.match(reloaded.first.detail, /retry after/);
    const saved = await readFile(cachePath, "utf8");
    assert.ok(!saved.includes("fixture-worker") && !saved.includes("fixture-keychain"));
    assert.ok(!JSON.parse(saved).claude_session, "legacy global Claude cache must be removed");
    assert.equal((await stat(cachePath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
