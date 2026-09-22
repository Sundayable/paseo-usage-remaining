import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeUsage } from "../server/usage.ts";

const resets5h = "2026-09-22T19:10:00.857534+00:00";
const resetsWk = "2026-09-24T02:00:00.857553+00:00";

// Exact shape returned by api.anthropic.com/api/oauth/usage on 2026-09-22 (the day
// after Opus 5.5 shipped): only Fable has a model-scoped weekly limit.
const today = {
  five_hour: { utilization: 16.0, resets_at: resets5h },
  seven_day: { utilization: 42.0, resets_at: resetsWk },
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_omelette: null,
  limits: [
    { kind: "session", group: "session", percent: 16, resets_at: resets5h, scope: null },
    { kind: "weekly_all", group: "weekly", percent: 42, resets_at: resetsWk, scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 70, resets_at: resetsWk, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
};

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test("today's body yields the three classic rows and nothing else", () => {
  const rows = byId(parseClaudeUsage(today));
  assert.deepEqual(Object.keys(rows), ["claude_session", "claude_week", "fable_week"]);
  assert.equal(rows.claude_session.remainingText, "84%");
  assert.equal(rows.claude_week.remainingText, "58%");
  assert.equal(rows.fable_week.remainingText, "30%");
  assert.equal(rows.fable_week.brand, "fable");
  assert.equal(rows.fable_week.status, "available");
});

test("a new model-scoped weekly limit (Opus 5.5) becomes its own labelled Claude row", () => {
  const body = {
    ...today,
    limits: [
      ...today.limits,
      { kind: "weekly_scoped", group: "weekly", percent: 25, resets_at: resetsWk, scope: { model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, surface: null } },
    ],
  };
  const rows = byId(parseClaudeUsage(body));
  assert.deepEqual(Object.keys(rows), ["claude_session", "claude_week", "fable_week", "claude_scoped_claude-opus-5-5"]);
  const opus = rows["claude_scoped_claude-opus-5-5"];
  assert.equal(opus.brand, "claude");
  assert.equal(opus.group, "weekly");
  assert.equal(opus.label, "Opus 5.5");
  assert.equal(opus.remainingText, "75%");
  assert.equal(opus.detail, "model-scoped weekly limit");
  assert.equal(opus.status, "available");
});

test("a scoped limit without a display name falls back to the model id, and duplicates collapse", () => {
  const body = {
    ...today,
    limits: [
      ...today.limits,
      { kind: "weekly_scoped", group: "weekly", percent: 10, resets_at: resetsWk, scope: { model: { id: "claude-opus-5-5", display_name: null }, surface: null } },
      { kind: "weekly_scoped", group: "weekly", percent: 99, resets_at: resetsWk, scope: { model: { id: "claude-opus-5-5", display_name: null }, surface: null } },
      { kind: "weekly_scoped", group: "weekly", percent: 99, resets_at: resetsWk, scope: { model: { id: null, display_name: "Fable" }, surface: null } },
    ],
  };
  const rows = parseClaudeUsage(body);
  assert.equal(rows.filter((r) => r.id === "claude_scoped_claude-opus-5-5").length, 1);
  assert.equal(rows.find((r) => r.id === "claude_scoped_claude-opus-5-5").label, "claude-opus-5-5");
  assert.equal(rows.filter((r) => r.id === "fable_week").length, 1);
  assert.equal(rows.find((r) => r.id === "fable_week").remainingText, "30%");
});

test("legacy seven_day_opus window is shown when limits[] has no Opus scope, and skipped when it does", () => {
  const legacyOnly = { ...today, seven_day_opus: { utilization: 60, resets_at: resetsWk } };
  const rows = byId(parseClaudeUsage(legacyOnly));
  assert.equal(rows.claude_scoped_opus.label, "Opus");
  assert.equal(rows.claude_scoped_opus.remainingText, "40%");

  const both = {
    ...legacyOnly,
    limits: [...today.limits, { kind: "weekly_scoped", group: "weekly", percent: 25, resets_at: resetsWk, scope: { model: { id: "claude-opus-5-5", display_name: "Opus 5.5" }, surface: null } }],
  };
  const ids = parseClaudeUsage(both).map((r) => r.id);
  assert.ok(ids.includes("claude_scoped_claude-opus-5-5"));
  assert.ok(!ids.includes("claude_scoped_opus"));
});

test("a body without limits[] or scoped windows still yields the three rows with Fable unavailable", () => {
  const rows = byId(parseClaudeUsage({ five_hour: { utilization: 0, resets_at: resets5h }, seven_day: { utilization: 5, resets_at: resetsWk } }));
  assert.deepEqual(Object.keys(rows), ["claude_session", "claude_week", "fable_week"]);
  assert.equal(rows.claude_session.remainingText, "100%");
  assert.equal(rows.fable_week.status, "unavailable");
  assert.equal(rows.fable_week.remainingText, "—");
});
