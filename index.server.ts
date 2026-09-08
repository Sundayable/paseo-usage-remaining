import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fetchUsage } from "./server/usage";
import { listUsage } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  server.handle(listUsage, fetchUsage);
  return () => {};
}
