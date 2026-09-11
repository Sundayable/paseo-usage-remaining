import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandWebComposer } from '../client/web-composer.ts';
function element(attrs = {}, initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, [value, '']]));
  return {
    attrs: { ...attrs }, children: [], parentElement: null,
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    style: {
      getPropertyValue(name) { return values.get(name)?.[0] ?? ''; },
      getPropertyPriority(name) { return values.get(name)?.[1] ?? ''; },
      setProperty(name, value, priority = '') { values.set(name, [value, priority]); },
      removeProperty(name) { const old = values.get(name)?.[0] ?? ''; values.delete(name); return old; },
    },
  };
}
function fixture(hidden) {
  const root = element();
  root.ownerDocument = { defaultView: { getComputedStyle: node => node.style } };
  const slot = element(hidden === undefined ? {} : { 'aria-hidden': hidden }, { width: '16px', height: '16px', overflow: 'hidden' });
  const label = element();
  const button = element({ role: 'button' }, { 'max-width': '160px' });
  root.parentElement = slot; slot.parentElement = button;
  slot.children = [root]; button.children = [slot, label];
  const track = element({}, { 'flex-direction': 'row' });
  const bar = element({}, { position: 'absolute', bottom: '0px' });
  const content = element({}, { display: 'flex', 'flex-direction': 'column' });
  button.parentElement = track; track.children = [button];
  track.parentElement = bar; bar.children = [track];
  bar.parentElement = content; content.children = [element(), bar];
  return { root, slot, button, label, track, bar, content };
}
test('expands only the owned web button, restores clipping and attributes on teardown', () => {
  const f = fixture('true');
  const cleanup = expandWebComposer(f.root, '#fff');
  assert.equal(typeof cleanup, 'function');
  assert.equal(f.slot.style.getPropertyValue('width'), 'auto');
  assert.equal(f.slot.style.getPropertyValue('overflow'), 'visible');
  assert.equal(f.slot.getAttribute('aria-hidden'), null);
  assert.equal(f.button.style.getPropertyValue('max-width'), '100%');
  assert.equal(f.label.style.getPropertyValue('display'), 'none');
  assert.equal(f.bar.style.getPropertyValue('position'), 'relative');
  assert.equal(f.bar.style.getPropertyValue('flex-shrink'), '0');
  assert.equal(f.bar.style.getPropertyValue('background-color'), '#fff');
  assert.equal(f.track.style.getPropertyValue('flex-wrap'), 'wrap');
  cleanup();
  assert.equal(f.slot.style.getPropertyValue('width'), '16px');
  assert.equal(f.slot.style.getPropertyValue('overflow'), 'hidden');
  assert.equal(f.slot.getAttribute('aria-hidden'), 'true');
  assert.equal(f.button.style.getPropertyValue('max-width'), '160px');
  assert.equal(f.label.style.getPropertyValue('display'), '');
  assert.equal(f.bar.style.getPropertyValue('position'), 'absolute');
  assert.equal(f.bar.style.getPropertyValue('background-color'), '');
});
test('supports the stable web renderer without aria-hidden and preserves its original state', () => {
  const f = fixture();
  const cleanup = expandWebComposer(f.root, '#fff');
  assert.ok(cleanup);
  cleanup();
  assert.equal(f.slot.getAttribute('aria-hidden'), null);
});
test('native refs or changed host structure leave the supported fallback intact', () => {
  assert.equal(expandWebComposer(null, '#fff'), null);
  assert.equal(expandWebComposer({ measure() {} }, '#fff'), null);
  const f = fixture();
  f.button.attrs.role = 'link';
  assert.equal(expandWebComposer(f.root, '#fff'), null);
  assert.equal(f.button.style.getPropertyValue('max-width'), '160px');
  assert.equal(f.label.style.getPropertyValue('display'), '');
});

test('does not expand the widget unless transcript space can be reserved safely', () => {
  const f = fixture();
  f.bar.style.setProperty('position', 'fixed');
  assert.equal(expandWebComposer(f.root, '#fff'), null);
  assert.equal(f.slot.style.getPropertyValue('width'), '16px');
  assert.equal(f.label.style.getPropertyValue('display'), '');
});
test('cleanup is idempotent and a theme remount changes the opaque band safely', () => {
  const f = fixture();
  const first = expandWebComposer(f.root, '#fff');
  first(); first();
  const second = expandWebComposer(f.root, '#16181d');
  assert.ok(second);
  assert.equal(f.bar.style.getPropertyValue('background-color'), '#16181d');
  second();
  assert.equal(f.bar.style.getPropertyValue('position'), 'absolute');
});

test('handles the real desktop tooltip display-contents wrapper without styling it', () => {
  const f = fixture();
  const tooltip = element({}, { display: 'contents' });
  tooltip.parentElement = f.track; tooltip.children = [f.button];
  f.button.parentElement = tooltip; f.track.children = [tooltip];
  const cleanup = expandWebComposer(f.root, '#fff');
  assert.ok(cleanup);
  assert.equal(f.bar.style.getPropertyValue('position'), 'relative');
  assert.equal(tooltip.style.getPropertyValue('display'), 'contents');
  cleanup();
});
