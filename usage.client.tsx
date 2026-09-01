import { type PluginClientContext, type PluginComposerPillProps, type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { providerLogos } from "./logos";
import { listUsage, type RemainingRow } from "./usage.shared";

function toneColor(theme: PluginSurfaceProps["theme"], tone: RemainingRow["tone"]): string {
  if (tone === "ok") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function useUsage() {
  const list = useRpc(listUsage);
  return useQuery({
    queryKey: ["usage-remaining"],
    queryFn: () => list({}),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

const MANUAL_REFRESH_COOLDOWN_MS = 120_000;
let manualRefreshAvailableAt = 0;
const manualRefreshListeners = new Set<() => void>();

function beginManualRefreshCooldown(): void {
  manualRefreshAvailableAt = Date.now() + MANUAL_REFRESH_COOLDOWN_MS;
  for (const listener of manualRefreshListeners) listener();
}

function useManualRefreshCooldown(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    manualRefreshListeners.add(update);
    const timer = setInterval(update, 1_000);
    return () => {
      manualRefreshListeners.delete(update);
      clearInterval(timer);
    };
  }, []);
  return Math.max(0, Math.ceil((manualRefreshAvailableAt - now) / 1_000));
}

function formatCooldown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function RefreshButton({
  theme,
  compact,
  isFetching,
  onRefresh,
}: {
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const cooldownSeconds = useManualRefreshCooldown();
  const disabled = isFetching || cooldownSeconds > 0;
  const label = cooldownSeconds > 0
    ? compact ? formatCooldown(cooldownSeconds) : `갱신 ${formatCooldown(cooldownSeconds)}`
    : isFetching
      ? compact ? "…" : "갱신 중…"
      : compact ? "↻" : "↻ 갱신";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cooldownSeconds > 0 ? `${cooldownSeconds}초 후 다시 갱신 가능` : "사용량 갱신"}
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

function BrandMark({
  row,
  theme,
  size,
}: {
  row: RemainingRow;
  theme: PluginSurfaceProps["theme"];
  size: number;
}) {
  const logoKey = row.brand === "fable" ? "claude" : row.brand;
  const uri = providerLogos[logoKey];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {uri ? <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size * 0.22 }} /> : null}
      {row.brand === "fable" ? (
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: size <= 16 ? 11 : 14, fontWeight: "700", letterSpacing: -0.2 }}
        >
          Fable
        </Text>
      ) : null}
      {!uri && row.brand !== "fable" ? (
        <Text style={{ color: theme.colors.foreground, fontSize: size <= 16 ? 11 : 14, fontWeight: "600" }}>{row.label}</Text>
      ) : null}
    </View>
  );
}

function UsageChip({
  row,
  theme,
  compact,
}: {
  row: RemainingRow;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
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

function GroupHeader({ theme, text, compact }: { theme: PluginSurfaceProps["theme"]; text: string; compact: boolean }) {
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

export function MainSurface({ theme, layout }: PluginSurfaceProps) {
  const usage = useUsage();
  const rows = usage.data?.rows ?? [];
  const session = rows.filter((r) => r.group === "session");
  const weekly = rows.filter((r) => r.group === "weekly");
  const styles = useMemo(
    () => ({
      screen: {
        flexGrow: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
        gap: layout.compact ? 10 : 12,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
      section: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "700" as const, marginTop: 8 },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: layout.compact ? 12 : 16,
      },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 4 },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.screen}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={styles.title}>남은 사용량</Text>
        <RefreshButton
          theme={theme}
          compact={false}
          isFetching={usage.isFetching}
          onRefresh={() => { void usage.refetch(); }}
        />
      </View>
      {usage.isError ? <Text style={styles.error}>{String(usage.error)}</Text> : null}
      <Text style={styles.section}>5시간 세션</Text>
      {session.map((row) => (
        <View key={row.id} style={styles.card}>
          <UsageChip row={row} theme={theme} compact={false} />
          {row.detail ? <Text style={styles.detail}>{row.detail}</Text> : null}
        </View>
      ))}
      <Text style={styles.section}>주간 한도</Text>
      {weekly.map((row) => (
        <View key={row.id} style={styles.card}>
          <UsageChip row={row} theme={theme} compact={false} />
          {row.detail ? <Text style={styles.detail}>{row.detail}</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

export function UsagePill({ theme }: PluginComposerPillProps) {
  const usage = useUsage();
  const rows = usage.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted }}>
        Usage…
      </Text>
    );
  }
  const session = rows.filter((r) => r.group === "session" && r.status === "available");
  const weekly = rows.filter((r) => r.group === "weekly" && r.status === "available");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, paddingVertical: 1 }}>
      <View style={{ flexDirection: "column", gap: 2, flexShrink: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <GroupHeader theme={theme} text="5H" compact />
          {session.map((row) => (
            <UsageChip key={row.id} row={row} theme={theme} compact />
          ))}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <GroupHeader theme={theme} text="WK" compact />
          {weekly.map((row) => (
            <UsageChip key={row.id} row={row} theme={theme} compact />
          ))}
        </View>
      </View>
      <RefreshButton
        theme={theme}
        compact
        isFetching={usage.isFetching}
        onRefresh={() => { void usage.refetch(); }}
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

export function contributeClient(client: PluginClientContext) {
  const pills = new Map<string, () => void>();

  function upsert(agentId: string, workspaceId: string) {
    pills.get(agentId)?.();
    pills.set(agentId, addPill(client, agentId, workspaceId));
  }

  void client.paseo.agents.list().then((result: { entries: Array<{ id: string; workspaceId?: string }> }) => {
    for (const entry of result.entries) {
      if (entry.workspaceId) upsert(entry.id, entry.workspaceId);
    }
  });

  const unsubscribe = client.paseo.agents.subscribe((update: { kind?: string; agent?: { id: string; workspaceId?: string | null } }) => {
    if (update.kind !== "upsert" || !update.agent?.workspaceId) return;
    upsert(update.agent.id, update.agent.workspaceId);
  });

  return () => {
    unsubscribe();
    for (const remove of pills.values()) remove();
  };
}
