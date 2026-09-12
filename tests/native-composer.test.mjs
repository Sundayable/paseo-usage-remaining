import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandNativeComposer } from '../client/native-composer.ts';
function fixture() {
  const hosts = [];
  function host(style, props = {}) {
    const calls = [];
    const node = {setNativeProps: value => calls.push(value)};
    const fiber = {memoizedProps: {style, ...props}, stateNode: {canonical: {publicInstance: node}}};
    hosts.push({fiber, calls});
    return fiber;
  }
  const root = host({});
  const slot = host({width:16,height:16,overflow:'hidden',alignItems:'center'});
  const button = host({maxWidth:160}, {accessibilityRole:'button'});
  const track = host({width:'100%',flexDirection:'row'});
  const bar = host({position:'absolute',bottom:0,left:0,right:0});
  const label = host({color:'#777'}, {numberOfLines:1,children:'Codex · WK 86%'});
  const diff = host({}, {testID:'composer-diff-stat-pill'});
  root.return=slot;slot.return=button;button.return=track;track.return=bar;
  button.child=slot;slot.child=root;slot.sibling=label;
  track.child=button;button.sibling=diff;
  return {hosts,slot,bar,track,diff,mount:{__internalInstanceHandle:root,setNativeProps(){} }};
}
test('native rich display reserves track space, hides only host label, and restores on cleanup',()=>{
  const f=fixture();
  const cleanup=expandNativeComposer(f.mount,358,'#fff',s=>s);
  assert.equal(typeof cleanup,'function');
  assert.equal(f.hosts[4].calls[0].style.position,'relative');
  assert.equal(f.hosts[4].calls[0].style.flexShrink,0);
  assert.equal(f.hosts[1].calls[0].style.width,332);
  assert.equal(f.hosts[1].calls[0].style.alignItems,'flex-start');
  assert.equal(f.hosts[5].calls[0].style.display,'none');
  cleanup();cleanup();
  assert.equal(f.hosts[4].calls.length,2);
  assert.equal(f.hosts[4].calls[1].style.position,'absolute');
  assert.equal(f.hosts[1].calls[1].style.width,16);
  assert.equal(f.hosts[1].calls[1].style.alignItems,'center');
  assert.equal(f.hosts[5].calls[1].style.display,null);
});

test("the host's diff badge is hidden while expanded and restored on cleanup",()=>{
  const f=fixture();
  const cleanup=expandNativeComposer(f.mount,358,'#fff',s=>s);
  assert.deepEqual(f.hosts[6].calls,[{style:{display:'none'}}]);
  cleanup();
  assert.deepEqual(f.hosts[6].calls.at(-1),{style:{display:null}});
});

test('a diff badge that re-renders or remounts is hidden again',async()=>{
  const f=fixture();
  const cleanup=expandNativeComposer(f.mount,358,'#fff',s=>s);
  try {
    // The host commits new counts; React restores its own style over ours.
    f.hosts[6].fiber.stateNode.canonical.currentProps={style:{}};
    await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(f.hosts[6].calls.length,2);
    assert.deepEqual(f.hosts[6].calls.at(-1),{style:{display:'none'}});
    // Zero changes unmount the badge; a later edit mounts a fresh host instance.
    const calls=[];
    f.hosts[6].fiber.stateNode.canonical={publicInstance:{setNativeProps:value=>calls.push(value)}};
    await new Promise(resolve=>setTimeout(resolve,2400));
    assert.deepEqual(calls,[{style:{display:'none'}}]);
  } finally { cleanup(); }
});

test('a missing diff badge leaves the rest of the expansion intact',()=>{
  const f=fixture();
  f.diff.memoizedProps.testID='other-pill';
  const cleanup=expandNativeComposer(f.mount,358,'#fff',s=>s);
  assert.equal(typeof cleanup,'function');
  assert.equal(f.hosts[6].calls.length,0);
  cleanup();
  assert.equal(f.hosts[6].calls.length,0);
});
test('unknown native refs or changed geometry are untouched',()=>{
  assert.equal(expandNativeComposer({},358,'#fff',s=>s),null);
  const f=fixture();f.slot.memoizedProps.style.width=24;
  assert.equal(expandNativeComposer(f.mount,358,'#fff',s=>s),null);
  assert.ok(f.hosts.every(h=>h.calls.length===0));
});
test('native adapter refuses expansion without a safe track and unambiguous label',()=>{
  const f=fixture();f.bar.memoizedProps.style.position='fixed';
  assert.equal(expandNativeComposer(f.mount,358,'#fff',s=>s),null);
  assert.ok(f.hosts.every(h=>h.calls.length===0));
});
test('partial native mutation failure rolls back earlier styles',()=>{
  const f=fixture();
  f.hosts[3].fiber.stateNode.canonical.publicInstance.setNativeProps=()=>{throw Error('unmounted');};
  // A disappearing native node can also reject restoration; earlier nodes must still restore.
  assert.equal(expandNativeComposer(f.mount,358,'#fff',s=>s),null);
  assert.equal(f.hosts[4].calls.at(-1).style.position,'absolute');
});
