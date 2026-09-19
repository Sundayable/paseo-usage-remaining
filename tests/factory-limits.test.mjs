import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFactoryLimits, withLastGood } from '../server/usage.ts';

// Shape read out of the droid CLI (0.212.1): GET api.factory.ai/api/billing/limits.
const now = Date.parse('2026-09-18T12:00:00Z');
const live = (usedPercent, windowEnd) => ({ usedPercent, windowEnd });
const fiveHourEnd = '2026-09-18T15:00:00Z';
const weeklyEnd = '2026-09-22T00:00:00Z';
const monthlyEnd = '2026-10-01T00:00:00Z';

test('factory: standard windows drive the 5H and WK rows, core goes in the detail', () => {
  const [session, weekly] = parseFactoryLimits({
    limits: {
      standard: {
        fiveHour: live(40, fiveHourEnd),
        weekly: live(62.4, weeklyEnd),
        monthly: live(10, monthlyEnd),
      },
      core: {
        fiveHour: live(5, fiveHourEnd),
        weekly: live(25, weeklyEnd),
        monthly: live(0, monthlyEnd),
      },
    },
    extraUsageBalanceCents: 0,
  }, now);

  assert.equal(session.id, 'factory_5h');
  assert.equal(session.brand, 'factory');
  assert.equal(session.label, 'Droid');
  assert.equal(session.group, 'session');
  assert.equal(session.status, 'available');
  assert.equal(session.remainingPct, 60);
  assert.equal(session.remainingText, '60%');
  assert.equal(session.resetIso, fiveHourEnd);
  assert.equal(session.tone, 'ok');
  assert.equal(session.detail, 'core 95% left');

  assert.equal(weekly.id, 'factory_week');
  assert.equal(weekly.group, 'weekly');
  assert.equal(weekly.remainingPct, 38);
  assert.equal(weekly.tone, 'warning');
  assert.equal(weekly.resetIso, weeklyEnd);
  assert.equal(weekly.detail, 'monthly 90% left · core 75% left');
});

test('factory: a window whose end has passed is the next untouched window — 100% remaining, not a missing chip', () => {
  // The CLI renders an elapsed windowEnd as 0% used with no countdown
  // ("Use Droid to start"), so the chip must survive a 5-hour rollover.
  const [session, weekly] = parseFactoryLimits({
    limits: {
      standard: {
        fiveHour: live(97, '2026-09-18T11:00:00Z'),
        weekly: live(0, weeklyEnd),
        monthly: live(0, monthlyEnd),
      },
    },
  }, now);

  assert.equal(session.status, 'available');
  assert.equal(session.remainingPct, 100);
  assert.equal(session.remainingText, '100%');
  assert.equal(session.resetIso, null);
  assert.equal(session.detail, 'no usage yet this window');

  // Zero-usage body: every standard window live and untouched.
  assert.equal(weekly.remainingPct, 100);
  assert.equal(weekly.detail, 'monthly 100% left');
});

test('factory: a body without limits.standard is unavailable, and so is a live window with no usedPercent', () => {
  for (const body of [null, undefined, {}, { limits: {} }, { limits: { standard: null } }]) {
    const rows = parseFactoryLimits(body, now);
    assert.deepEqual(rows.map((r) => r.id), ['factory_5h', 'factory_week']);
    assert.ok(rows.every((r) => r.status === 'unavailable'), `expected unavailable for ${JSON.stringify(body)}`);
  }

  const [session] = parseFactoryLimits({ limits: { standard: { fiveHour: { windowEnd: fiveHourEnd } } } }, now);
  assert.equal(session.status, 'unavailable');
  assert.equal(session.remainingText, '—');
});

test('factory: with no FACTORY_API_KEY the rows are unavailable and explain why', () => {
  // fetchFactory builds these rows directly; assert the contract they must meet.
  const [session, weekly] = parseFactoryLimits(null, now)
    .map((r) => ({ ...r, detail: 'set FACTORY_API_KEY' }));
  assert.equal(session.status, 'unavailable');
  assert.equal(weekly.status, 'unavailable');
  assert.equal(session.detail, 'set FACTORY_API_KEY');
  // An unavailable row with no cached value stays hidden rather than showing a stale %.
  assert.deepEqual(withLastGood([session, weekly], now, new Map()), [session, weekly]);
});

test('factory: an API error after a good read keeps a dimmed placeholder instead of dropping the chip', () => {
  const good = {
    id: 'factory_5h', brand: 'factory', group: 'session', label: 'Droid', remainingText: '60%',
    remainingPct: 60, resetAt: '3h', resetIso: '2026-09-18T11:00:00Z', detail: null, tone: 'ok', status: 'available',
  };
  const cache = new Map([[good.id, { row: good, at: now - 60 * 60_000 }]]);
  const errored = {
    ...good, remainingText: '—', remainingPct: null, resetAt: null, resetIso: null,
    tone: 'default', status: 'unavailable', detail: 'Factory API 500',
  };
  const [merged] = withLastGood([errored], now, cache);
  assert.equal(merged.status, 'error');
  assert.equal(merged.brand, 'factory');
  assert.equal(merged.label, 'Droid');
  assert.equal(merged.remainingText, '—');
  assert.match(merged.detail, /window reset/);
});

test('factory: a full live-shaped body, including the fields the CLI binary did not reveal', () => {
  // Field-for-field shape of a real HTTP 200 from GET /api/billing/limits, with
  // representative figures in place of an account's own. `secondsRemaining` and
  // `usesTokenRateLimitsBilling` only showed up on the wire, not in the binary.
  //
  // The load-bearing part is windowEnd:null on fiveHour: an idle 5-hour window is
  // reported that way rather than as an elapsed timestamp, because no window opens
  // until Droid is used. The CLI's own YHC() treats null and elapsed identically
  // (0% used, no countdown), so both must reach the same branch here or the 5H chip
  // disappears whenever Droid has been idle.
  const body = {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 40, windowEnd: '2026-09-22T00:00:00.000Z', secondsRemaining: 302400 },
        monthly: { usedPercent: 25, windowEnd: '2026-10-01T00:00:00.000Z', secondsRemaining: 1080000 },
      },
      core: {
        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
        weekly: { usedPercent: 30, windowEnd: '2026-09-24T00:00:00.000Z', secondsRemaining: 475200 },
        monthly: { usedPercent: 10, windowEnd: '2026-10-17T00:00:00.000Z', secondsRemaining: 2462400 },
      },
    },
    overagePreference: null,
    canManageOverage: true,
    extraUsageBalanceCents: 0,
    extraUsageAllowed: true,
  };
  const [session, weekly] = parseFactoryLimits(body, Date.parse('2026-09-18T12:00:00Z'));

  assert.equal(session.status, 'available');
  assert.equal(session.remainingText, '100%');
  assert.equal(session.resetIso, null);
  assert.equal(session.detail, 'no usage yet this window · core 100% left');

  assert.equal(weekly.status, 'available');
  assert.equal(weekly.remainingText, '60%');
  assert.equal(weekly.resetIso, '2026-09-22T00:00:00.000Z');
  // resetAt is a countdown against the real wall clock, so it is deliberately not asserted.
  assert.equal(weekly.detail, 'monthly 75% left · core 70% left');
});
