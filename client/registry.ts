import type { ComponentType } from "react";
import type { PluginClientContext, PluginButtonRegistration, PluginButtonIcon, PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { UsageSnapshot } from "../shared/usage";

type Agent = { id: string; workspaceId?: string | null; provider: string };

export function usageLabel(provider: string, snapshot?: UsageSnapshot): string {
  const brand = provider.split("/")[0];
  const rows = snapshot?.rows.filter((row) => row.brand === brand && row.status === "available") ?? [];
  if (!snapshot) return "Usage…";
  if (!rows.length) {
    // A state the user has to fix (e.g. Claude Code signed out) is named, not hidden.
    const notice = snapshot.rows.find((row) => row.brand === brand && row.status === "error" && row.remainingText !== "—");
    return notice ? `${notice.label} · ${notice.remainingText}` : "Usage unavailable";
  }
  const head = rows[0].label;
  return `${head} · ${rows.map((row) => {
    const window = row.brand === "cursor" ? "MO" : row.group === "session" ? "5H" : "WK";
    // A model-scoped row (e.g. "Opus 5.5") carries its own name so two WK values stay distinguishable.
    const prefix = row.label !== head ? `${row.label} ` : "";
    return `${prefix}${window} ${row.remainingText}`;
  }).join(" · ")}`;
}

// Paseo 0.9 delivers agent_update to agents.subscribe() only while an agents.list
// subscription is open, so the first page asks for one and owns its lifetime.
// On 0.8 `subscribe` is a plain request field and no handle comes back.
export function registerUsagePills(client: PluginClientContext, fetchUsage: () => Promise<UsageSnapshot>, icon: PluginButtonIcon = "Gauge", mobileContent?: ComponentType<PluginButtonContentProps>) {
  const pills = new Map<string, { agent: Agent; registration: PluginButtonRegistration }>();
  const changedDuringBootstrap = new Set<string>();
  let stopped = false;
  let bootstrapping = true;
  let fetching = false;
  let snapshot: UsageSnapshot | undefined;
  let agentFeed: { release(): Promise<void> } | undefined;
  function releaseFeed() {
    agentFeed?.release().catch(() => { /* The host already dropped the subscription. */ });
    agentFeed = undefined;
  }

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
      const result: { entries: { agent: Agent }[]; pageInfo?: { hasMore?: boolean; nextCursor?: string | null }; subscription?: { release(): Promise<void> } } =
        cursor ? await client.paseo.agents.list({ page: { limit: 100, cursor } }) : await client.paseo.agents.list({ page: { limit: 100 }, subscribe: {} });
      if (result.subscription) agentFeed = result.subscription;
      if (stopped) { releaseFeed(); return; }
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
    releaseFeed();
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}
