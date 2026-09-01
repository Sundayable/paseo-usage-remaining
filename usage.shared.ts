import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const RemainingToneSchema = z.enum(["default", "ok", "warning", "danger"]);

export const RemainingRowSchema = z.object({
  id: z.string(),
  brand: z.enum(["claude", "fable", "codex", "grok", "cursor"]),
  group: z.enum(["session", "weekly"]),
  label: z.string(),
  remainingText: z.string(),
  remainingPct: z.number().nullable(),
  resetAt: z.string().nullable(),
  resetIso: z.string().nullable().optional(),
  detail: z.string().nullable(),
  tone: RemainingToneSchema,
  status: z.enum(["available", "unavailable", "error"]),
});

export const UsageSnapshotSchema = z.object({
  fetchedAt: z.string(),
  pillText: z.string(),
  rows: z.array(RemainingRowSchema),
});

export const listUsage = defineRpc({
  name: "usage.list",
  input: z.object({ force: z.boolean().optional() }),
  output: UsageSnapshotSchema,
});

export type RemainingRow = z.infer<typeof RemainingRowSchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
