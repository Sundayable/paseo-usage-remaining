import type { ComponentType } from "react";
import type { PluginClientContext, PluginButtonRegistration, PluginButtonIcon, PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { UsageSnapshot } from "../shared/usage";

type Agent = { id: string; workspaceId?: string | null; provider: string };

export function usageLabel(provider: string, snapshot?: UsageSnapshot): string {
  const brand = provider.split("/")[0];
  const rows = snapshot?.rows.filter((row) => row.brand === brand && row.status === "available") ?? [];
  if (!snapshot) return "Usage…";
  if (!rows.length) return "Usage unavailable";
  return `${rows[0].label} · ${rows.map((row) => `${row.brand === "cursor" ? "MO" : row.group === "session" ? "5H" : "WK"} ${row.remainingText}`).join(" · ")}`;
}

// Use the SDK shipped with Paseo 0.8.0, not the newer unreleased owned-list API.
export function registerUsagePills(client: PluginClientContext, fetchUsage: () => Promise<UsageSnapshot>, icon: PluginButtonIcon = "Gauge", mobileContent?: ComponentType<PluginButtonContentProps>) {
  const pills = new Map<string, { agent: Agent; registration: PluginButtonRegistration }>();
  const changedDuringBootstrap = new Set<string>();
  let stopped = false;
  let bootstrapping = true;
  let fetching = false;
  let snapshot: UsageSnapshot | undefined;

  function remove(id: string) {
    pills.get(id)?.registration.remove();
    pills.delete(id);
  }

  function upsert(agent: Agent) {
    if (stopped) return;
    if (!agent.workspaceId) { remove(agent.id); return; }
    const existing = pills.get(agent.id);
    const label = usageLabel(agent.provider, snapshot);
    if (existing?.agent.workspaceId === agent.workspaceId) {
      existing.agent = agent;
      existing.registration.update({ label });
      return;
    }
    remove(agent.id);
    const registration = client.addComposerPill({
      id: "usage", workspaceId: agent.workspaceId, agentId: agent.id,
      button: {
        title: "Remaining usage · open all providers", icon, label,
        behavior: mobileContent ? { kind: "popover", Content: mobileContent } : { kind: "action", onPress() { client.openSurface("main"); } },
      },
    });
    pills.set(agent.id, { agent, registration });
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (stopped) return;
    const id = update.kind === "remove" ? update.agentId : update.agent.id;
    if (bootstrapping) changedDuringBootstrap.add(id);
    if (update.kind === "remove") remove(id);
    else upsert(update.agent);
  });

  void (async () => {
    let cursor: string | undefined;
    do {
      const result = await client.paseo.agents.list({ page: { limit: 100, cursor } });
      if (stopped) return;
      for (const { agent } of result.entries) {
        if (!changedDuringBootstrap.has(agent.id)) upsert(agent);
      }
      const next = result.pageInfo?.nextCursor ?? undefined;
      if (!result.pageInfo?.hasMore || !next || next === cursor) break;
      cursor = next;
    } while (!stopped);
  })().catch(() => {
    if (!stopped) console.error("[usage-remaining] Agent list unavailable; live updates remain subscribed.");
  }).finally(() => { bootstrapping = false; changedDuringBootstrap.clear(); });

  async function refresh() {
    if (stopped || fetching) return;
    fetching = true;
    try {
      const next = await fetchUsage();
      if (stopped) return;
      snapshot = next;
      for (const { agent, registration } of pills.values()) {
        registration.update({ label: usageLabel(agent.provider, snapshot) });
      }
    } catch {
      if (!stopped) for (const { registration } of pills.values()) registration.update({ label: "Usage unavailable" });
    } finally { fetching = false; }
  }
  void refresh();
  const timer = setInterval(() => void refresh(), 60_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}
