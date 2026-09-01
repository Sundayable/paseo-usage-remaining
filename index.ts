import type { PluginContext } from "@getpaseo/plugin";
import { contributeClient, MainSurface } from "./usage.client";
import { fetchUsage } from "./usage.server";
import { listUsage } from "./usage.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(listUsage, fetchUsage);
  plugin.addSurface("main", MainSurface);
  plugin.addSidebarItem({
    id: "main",
    title: "Remaining",
    icon: "Gauge",
    surface: "main",
  });
  plugin.addCommandCenterItem({
    id: "open-usage",
    title: "Open remaining usage",
    icon: "Gauge",
    keywords: ["quota", "usage", "claude", "fable", "codex", "grok", "cursor"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("main");
    },
  });
  plugin.addClientSide(contributeClient);
  return () => {};
}
