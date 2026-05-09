import { loadConfig, resolveDataDir } from "@openacme/config";
import {
  getPlatformLifecycle,
  logPath,
  pollHealth,
  tailFile,
} from "../lifecycle/index.js";

interface StatusOpts {
  dataDir?: string;
  noService?: boolean;
}

function formatUptime(start: Date | undefined): string {
  if (!start) return "—";
  const ms = Date.now() - start.getTime();
  if (ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${sec % 60}s`;
  return `${sec}s`;
}

export async function statusCommand(opts: StatusOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const config = loadConfig(dataDir);
  const lifecycle = getPlatformLifecycle({ dataDir, forceNoService: opts.noService });
  const status = await lifecycle.status();

  const dot = status.running ? "●" : "○";
  const state = status.running ? "running" : "stopped";
  console.log(`${dot} openacme — ${state}`);
  console.log(`  pid:        ${status.pid ?? "—"}`);
  console.log(`  bind:       ${config.server.host}:${config.server.port}`);
  console.log(
    `  uptime:     ${formatUptime(status.startedAt)}${status.startedAt ? ` (since ${status.startedAt.toISOString()})` : ""}`
  );
  console.log(
    `  service:    ${lifecycle.kind}${status.unitInstalled ? ", auto-start enabled" : status.running ? "" : ", not installed"}`
  );
  console.log(`  unit:       ${lifecycle.unitPath()}`);
  console.log(`  data dir:   ${dataDir}`);

  if (status.running) {
    const url = `http://127.0.0.1:${config.server.port}/api/health`;
    const healthy = await pollHealth(url, 1000);
    console.log(`  health:     ${healthy ? "200 OK" : "no response"} (${url})`);
  }

  const lp = logPath(dataDir);
  console.log(`  recent log: ${lp}`);
  const tail = tailFile(lp, 5);
  if (tail) {
    for (const line of tail.split("\n")) {
      console.log(`    ${line}`);
    }
  }
}
