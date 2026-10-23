import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeTeamCredentials } from "../server/usage.ts";
import { credentialKey } from "../server/claude-poll.ts";
const run = promisify(execFile);

test("Team B selection fails closed on missing enrollment, insecure files, and Personal credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-team-"));
  const auth = join(root, ".config/agent-core/auth"), paseo = join(root, ".paseo");
  try {
    await mkdir(auth, {recursive:true}); await mkdir(paseo);
    await writeFile(join(auth, "claude.env"), "CLAUDE_CODE_OAUTH_TOKEN=fixture-personal\n");
    const path = join(auth, "claude-b.env");
    await writeFile(path, "CLAUDE_CODE_OAUTH_TOKEN=fixture-team\n", {mode:0o600});
    assert.deepEqual((await readClaudeTeamCredentials(root)).creds, []);
    await writeFile(join(paseo, "usage-remaining.accounts.json"), JSON.stringify({[credentialKey("fixture-team")]:"Sundayable Team (B)"}));
    assert.deepEqual((await readClaudeTeamCredentials(root)).creds.map(c=>c.token), ["fixture-team"]);
    await chmod(path, 0o644);
    assert.deepEqual((await readClaudeTeamCredentials(root)).creds, []);
    await rm(path); await symlink(join(auth,"claude.env"),path);
    assert.deepEqual((await readClaudeTeamCredentials(root)).creds, []);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("Team RPC requests only B, preserves observation time, omits Cursor, and never falls back to A", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-team-rpc-"));
  const auth=join(root,".config/agent-core/auth"), paseo=join(root,".paseo"), bin=join(root,"bin");
  try {
    await mkdir(auth,{recursive:true}); await mkdir(paseo); await mkdir(bin);
    await writeFile(join(bin,"security"), '#!/bin/sh\nexit 1\n',{mode:0o700});
    await writeFile(join(auth,"claude.env"),"CLAUDE_CODE_OAUTH_TOKEN=fixture-personal\n");
    await writeFile(join(auth,"claude-b.env"),"CLAUDE_CODE_OAUTH_TOKEN=fixture-team\n",{mode:0o600});
    await writeFile(join(paseo,"usage-remaining.accounts.json"),JSON.stringify({[credentialKey("fixture-team")]:"Sundayable Team (B)"}));
    const script = `
      import {fetchUsage,flushUsageCache} from ${JSON.stringify(new URL("../server/usage.ts",import.meta.url).href)};
      let calls=0;
      globalThis.fetch=async (url,init)=>{
        if(url !== 'https://api.anthropic.com/api/oauth/usage' || init.headers.Authorization !== 'Bearer fixture-team') throw Error('Unexpected provider or credential');
        calls++;
        return new Response(JSON.stringify({five_hour:{utilization:27,resets_at:new Date(Date.now()+3600000).toISOString()},seven_day:{utilization:49,resets_at:new Date(Date.now()+86400000).toISOString()}}));
      };
      const first=await fetchUsage({force:true,claudeContext:'sundayable-team'});
      const second=await fetchUsage({force:true,claudeContext:'sundayable-team'});
      await flushUsageCache();
      console.log('RESULT:'+JSON.stringify({calls,first,second}));
    `;
    const result=await run(process.execPath,["--input-type=module","-e",script],{env:{HOME:root,PASEO_HOME:paseo,PATH:`${bin}:${process.env.PATH}`},timeout:10000});
    const data=JSON.parse(result.stdout.split('\n').find(l=>l.startsWith('RESULT:')).slice(7));
    assert.equal(data.calls,1);
    const first=data.first.rows.find(r=>r.id==='claude_session'),second=data.second.rows.find(r=>r.id==='claude_session');
    assert.equal(first.remainingPct,73); assert.equal(first.accountScope,'sundayable-team');
    assert.ok(first.observedAt>0); assert.equal(second.observedAt,first.observedAt);
    assert.ok(!data.first.rows.some(r=>r.id==='cursor_month'));
    assert.ok(!JSON.stringify(data).includes('fixture-team'));
  } finally {await rm(root,{recursive:true,force:true});}
});
