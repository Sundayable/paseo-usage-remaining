import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient, MainSurface } from "./client/usage";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", MainSurface);
  client.addSidebarItem({
    id: "main",
    title: "Remaining",
    icon: "Gauge",
    surface: "main",
  });
  client.addCommandCenterItem({
    id: "open-usage",
    title: "Open remaining usage",
    icon: "Gauge",
    keywords: ["quota", "usage", "claude", "fable", "codex", "grok", "cursor"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("main");
    },
  });
  return contributeClient(client);
}
