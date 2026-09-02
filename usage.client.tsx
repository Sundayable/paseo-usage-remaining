import { type PluginClientContext, type PluginComposerPillProps, type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { providerLogos } from "./logos";
import { listUsage, type RemainingRow, type UsageSnapshot } from "./usage.shared";

type Theme = PluginSurfaceProps["theme"];

const QUERY_KEY = ["usage-remaining"] as const;
const AUTO_REFRESH_MS = 60_000;
const MANUAL_REFRESH_COOLDOWN_MS = 120_000;

function toneColor(theme: Theme, tone: RemainingRow["tone"]): string {
  if (tone === "ok") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function useUsage() {
  const list = useRpc(listUsage);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => list({}),
    refetchInterval: AUTO_REFRESH_MS,
    staleTime: 30_000,
  });
  return {
    ...query,
    manualRefresh: async () => {
      const data = await list({ force: true });
      queryClient.setQueryData<UsageSnapshot>(QUERY_KEY, data);
      return data;
    },
  };
}

// Shared across every pill and the dashboard so one manual refresh starts one cooldown.
let manualRefreshAvailableAt = 0;
const manualRefreshListeners = new Set<() => void>();

function beginManualRefreshCooldown(): void {
  manualRefreshAvailableAt = Date.now() + MANUAL_REFRESH_COOLDOWN_MS;
  for (const listener of manualRefreshListeners) listener();
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    manualRefreshListeners.add(update);
    const timer = setInterval(update, intervalMs);
    return () => {
      manualRefreshListeners.delete(update);
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

function useManualRefreshCooldown(): number {
  const now = useNow(1_000);
  return Math.max(0, Math.ceil((manualRefreshAvailableAt - now) / 1_000));
}

function formatCooldown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatAgo(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function RefreshButton({
  theme,
  compact,
  isFetching,
  onRefresh,
}: {
  theme: Theme;
  compact: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const cooldownSeconds = useManualRefreshCooldown();
  const disabled = isFetching || cooldownSeconds > 0;
  const label = cooldownSeconds > 0
    ? compact ? formatCooldown(cooldownSeconds) : `Refresh in ${formatCooldown(cooldownSeconds)}`
    : isFetching
      ? compact ? "…" : "Refreshing…"
      : compact ? "↻" : "↻ Refresh";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cooldownSeconds > 0 ? `Refresh available in ${cooldownSeconds} seconds` : "Refresh usage"}
      disabled={disabled}
      onPress={(event) => {
        event.stopPropagation();
        if (disabled) return;
        beginManualRefreshCooldown();
        onRefresh();
      }}
      style={{
        minWidth: compact ? 32 : 76,
        height: compact ? 24 : 34,
        paddingHorizontal: compact ? 6 : 12,
        borderRadius: compact ? 7 : 9,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ color: disabled ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: compact ? 10 : 13, fontWeight: "700" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function BrandMark({ row, theme, size }: { row: RemainingRow; theme: Theme; size: number }) {
  const logoKey = row.brand === "fable" ? "claude" : row.brand;
  const uri = providerLogos[logoKey];
  const showName = row.brand === "fable" || !uri;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {uri ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size * 0.22 }} /> : null}
      {showName ? (
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: size <= 16 ? 11 : 14, fontWeight: "700", letterSpacing: -0.2 }}
        >
          {row.label}
        </Text>
      ) : null}
    </View>
  );
}

function UsageChip({ row, theme, compact }: { row: RemainingRow; theme: Theme; compact: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: compact ? 4 : 8 }}>
      <BrandMark row={row} theme={theme} size={compact ? 14 : 22} />
      <Text style={{ color: toneColor(theme, row.tone), fontSize: compact ? 12 : 18, fontWeight: "700" }}>
        {row.remainingText}
      </Text>
      {row.resetAt ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 10 : 13 }}>{row.resetAt}</Text>
      ) : null}
    </View>
  );
}

function GroupHeader({ theme, text, compact }: { theme: Theme; text: string; compact: boolean }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 9 : 12,
        fontWeight: "700",
        letterSpacing: 0.6,
        width: compact ? 22 : undefined,
      }}
    >
      {text}
    </Text>
  );
}

function RemainingBar({ row, theme }: { row: RemainingRow; theme: Theme }) {
  if (row.remainingPct == null) return null;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: row.remainingPct }}
      style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden", marginTop: 10 }}
    >
      <View style={{ width: `${row.remainingPct}%`, height: "100%", backgroundColor: toneColor(theme, row.tone) }} />
    </View>
  );
}

function UsageCard({ row, theme, compact }: { row: RemainingRow; theme: Theme; compact: boolean }) {
  const unavailable = row.status !== "available";
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: compact ? 12 : 16,
        opacity: unavailable ? 0.6 : 1,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <UsageChip row={row} theme={theme} compact={false} />
        {row.resetAt ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>resets in {row.resetAt}</Text>
        ) : null}
      </View>
      <RemainingBar row={row} theme={theme} />
      {row.detail ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 6 }}>{row.detail}</Text>
      ) : null}
    </View>
  );
}

export function MainSurface({ theme, layout }: PluginSurfaceProps) {
  const usage = useUsage();
  const now = useNow(15_000);
  const rows = usage.data?.rows ?? [];
  const session = rows.filter((r) => r.group === "session");
  const weekly = rows.filter((r) => r.group === "weekly");
  const updated = formatAgo(usage.data?.fetchedAt, now);
  const styles = useMemo(
    () => ({
      screen: {
        flexGrow: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
        gap: layout.compact ? 10 : 12,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      section: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "700" as const, marginTop: 8 },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.screen}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ gap: 2 }}>
          <Text style={styles.title}>Remaining usage</Text>
          {updated ? <Text style={styles.subtitle}>Updated {updated} · auto-refreshes every minute</Text> : null}
        </View>
        <RefreshButton
          theme={theme}
          compact={false}
          isFetching={usage.isFetching}
          onRefresh={() => { void usage.manualRefresh(); }}
        />
      </View>
      {usage.isError ? <Text style={styles.error}>{String(usage.error)}</Text> : null}
      {!usage.data && !usage.isError ? <Text style={styles.subtitle}>Loading…</Text> : null}
      <Text style={styles.section}>5-hour session</Text>
      {session.map((row) => (
        <UsageCard key={row.id} row={row} theme={theme} compact={layout.compact} />
      ))}
      <Text style={styles.section}>Weekly (Cursor: monthly)</Text>
      {weekly.map((row) => (
        <UsageCard key={row.id} row={row} theme={theme} compact={layout.compact} />
      ))}
    </ScrollView>
  );
}

export function UsagePill({ theme }: PluginComposerPillProps) {
  const usage = useUsage();
  const rows = usage.data?.rows ?? [];
  const session = rows.filter((r) => r.group === "session" && r.status === "available");
  const weekly = rows.filter((r) => r.group === "weekly" && r.status === "available");
  if (session.length === 0 && weekly.length === 0) {
    return (
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted }}>
        {usage.data ? "Usage unavailable" : "Usage…"}
      </Text>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, paddingVertical: 1 }}>
      <View style={{ flexDirection: "column", gap: 2, flexShrink: 1 }}>
        {session.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <GroupHeader theme={theme} text="5H" compact />
            {session.map((row) => (
              <UsageChip key={row.id} row={row} theme={theme} compact />
            ))}
          </View>
        ) : null}
        {weekly.length > 0 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <GroupHeader theme={theme} text="WK" compact />
            {weekly.map((row) => (
              <UsageChip key={row.id} row={row} theme={theme} compact />
            ))}
          </View>
        ) : null}
      </View>
      <RefreshButton
        theme={theme}
        compact
        isFetching={usage.isFetching}
        onRefresh={() => { void usage.manualRefresh(); }}
      />
    </View>
  );
}

function addPill(client: PluginClientContext, agentId: string, workspaceId: string) {
  return client.addComposerPill({
    id: "usage",
    title: "Remaining usage",
    workspaceId,
    agentId,
    Component: UsagePill,
    onPress() {
      client.openSurface("main");
    },
  });
}

type AgentUpdate =
  | { kind: "upsert"; agent?: { id: string; workspaceId?: string | null } }
  | { kind: "remove"; agentId: string }
  | { kind?: string };

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, () => void>();

  function upsert(agentId: string, workspaceId: string) {
    pills.get(agentId)?.();
    pills.set(agentId, addPill(client, agentId, workspaceId));
  }

  function remove(agentId: string) {
    pills.get(agentId)?.();
    pills.delete(agentId);
  }

  void client.paseo.agents.list().then((result: { entries: Array<{ id: string; workspaceId?: string | null }> }) => {
    for (const entry of result.entries) {
      if (entry.workspaceId) upsert(entry.id, entry.workspaceId);
    }
  });

  const unsubscribe = client.paseo.agents.subscribe((update: AgentUpdate) => {
    if (update.kind === "remove" && "agentId" in update) {
      remove(update.agentId);
      return;
    }
    if (update.kind === "upsert" && "agent" in update && update.agent?.workspaceId) {
      upsert(update.agent.id, update.agent.workspaceId);
    }
  });

  return () => {
    unsubscribe();
    for (const dispose of pills.values()) dispose();
    pills.clear();
  };
}
