import { resolveDataDir } from "@openacme/config";
import { getPlatformLifecycle, clearPid } from "../lifecycle/index.js";

interface StopOpts {
  dataDir?: string;
  noService?: boolean;
}

export async function stopCommand(opts: StopOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const lifecycle = getPlatformLifecycle({ dataDir, forceNoService: opts.noService });
  const before = await lifecycle.status();
  if (!before.running) {
    console.log("✓ openacme is not running");
    return;
  }
  await lifecycle.stopService();
  // Best-effort PID file cleanup. The OS service managers don't use the
  // PID file, but keeping it stale is misleading.
  clearPid(dataDir);
  console.log("✓ stopped");
}
