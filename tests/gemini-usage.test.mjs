import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiStatus, createGeminiPoller } from '../server/gemini-usage.ts';
const NOW=Date.parse('2026-11-20T05:22:08Z');
const sample=()=>({product:'antigravity',plan_tier:'Google AI Pro',observedAt:NOW,quota:{
 'gemini-5h':{remaining_fraction:0.8709439,reset_time:'2026-11-20T09:11:58Z'},
 'gemini-weekly':{remaining_fraction:0.95943934,reset_time:'2026-11-27T04:11:58Z'},
 '3p-weekly':{remaining_fraction:0,reset_time:'2026-11-27T04:11:58Z'},
 'gemini-argon-wtu-weekly':{remaining_fraction:1,reset_time:'2026-11-27T04:11:58Z'},
}});
test('official live shape: shared Gemini buckets only; fraction becomes percentage across consumer plans',()=>{
 for(const plan of ['Google AI Pro','Google AI Ultra','Google AI Plus']){
  const s=sample();s.plan_tier=plan;
  const rows=parseGeminiStatus(s,NOW);
  assert.deepEqual(rows.map(r=>r.remainingPct),[87.1,95.9]);
  assert.deepEqual(rows.map(r=>r.id),['gemini_session','gemini_week']);
  assert.deepEqual(rows.map(r=>r.label),[`Gemini · ${plan}`,`Gemini · ${plan}`]);
  assert.equal(rows[0].observedAt,NOW);
  assert.equal(rows[0].resetIso,'2026-11-20T09:11:58.000Z');
 }
});
test('missing, disabled, invalid, amount-only, expired and stale never become 100%',()=>{
 for(const bad of [null,NaN,-0.01,1.01,'0.5']){
  const s=sample();s.quota['gemini-5h'].remaining_fraction=bad;
  assert.equal(parseGeminiStatus(s,NOW)[0].remainingPct,null);
 }
 for(const mutate of [s=>{s.quota['gemini-5h'].disabled=true},s=>{s.quota['gemini-5h']={remaining_amount:100}},s=>{s.quota['gemini-5h'].reset_time='invalid'},s=>{s.quota['gemini-5h'].reset_time=new Date(NOW).toISOString()},s=>{s.plan_tier='Enterprise'},s=>{s.plan_tier='untrusted'},s=>{s.observedAt=NOW+1},s=>{s.observedAt=NOW-600001}]){
  const s=sample();mutate(s);const rows=parseGeminiStatus(s,NOW);
  assert.equal(rows[0].remainingPct,null);
  assert.doesNotMatch(rows[0].label,/Enterprise|untrusted/);
 }
 const s=sample();s.quota['gemini-5h'].remaining_fraction=0;
 assert.equal(parseGeminiStatus(s,NOW)[0].remainingPct,0);
 assert.equal(parseGeminiStatus({},NOW)[1].status,'unavailable');
 assert.equal(parseGeminiStatus({},NOW)[1].label,'Gemini');
});
test('single flight, five minute attempt budget, failed probe drops account data',async()=>{
 let calls=0,now=NOW;let release;const gate=new Promise(r=>release=r);
 const poll=createGeminiPoller(async()=>{calls++;await gate;if(calls>1)throw Error('SECRET');return sample()},()=>now);
 const first=poll(),second=poll();release();
 assert.deepEqual(await first,await second);assert.equal(calls,1);
 now+=299999;await poll();assert.equal(calls,1);
 now++;const failed=await poll();assert.equal(calls,2);
 assert.ok(failed.every(r=>r.remainingPct===null));assert.doesNotMatch(JSON.stringify(failed),/SECRET/);
});
