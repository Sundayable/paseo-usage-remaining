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
  const slot = element(hidden === undefined ? {} : { 'aria-hidden': hidden }, { width: '16px', height: '16px', overflow: 'hidden' });
  const label = element();
  const button = element({ role: 'button' }, { 'max-width': '160px' });
  root.parentElement = slot; slot.parentElement = button;
  slot.children = [root]; button.children = [slot, label];
  return { root, slot, button, label };
}
test('expands only the owned web button, restores clipping and attributes on teardown', () => {
  const f = fixture('true');
  const cleanup = expandWebComposer(f.root);
  assert.equal(typeof cleanup, 'function');
  assert.equal(f.slot.style.getPropertyValue('width'), 'auto');
  assert.equal(f.slot.style.getPropertyValue('overflow'), 'visible');
  assert.equal(f.slot.getAttribute('aria-hidden'), null);
  assert.equal(f.button.style.getPropertyValue('max-width'), '100%');
  assert.equal(f.label.style.getPropertyValue('display'), 'none');
  cleanup();
  assert.equal(f.slot.style.getPropertyValue('width'), '16px');
  assert.equal(f.slot.style.getPropertyValue('overflow'), 'hidden');
  assert.equal(f.slot.getAttribute('aria-hidden'), 'true');
  assert.equal(f.button.style.getPropertyValue('max-width'), '160px');
  assert.equal(f.label.style.getPropertyValue('display'), '');
});
test('supports the stable web renderer without aria-hidden and preserves its original state', () => {
  const f = fixture();
  const cleanup = expandWebComposer(f.root);
  assert.ok(cleanup);
  cleanup();
  assert.equal(f.slot.getAttribute('aria-hidden'), null);
});
test('native refs or changed host structure leave the supported fallback intact', () => {
  assert.equal(expandWebComposer(null), null);
  assert.equal(expandWebComposer({ measure() {} }), null);
  const f = fixture();
  f.button.attrs.role = 'link';
  assert.equal(expandWebComposer(f.root), null);
  assert.equal(f.button.style.getPropertyValue('max-width'), '160px');
  assert.equal(f.label.style.getPropertyValue('display'), '');
});
