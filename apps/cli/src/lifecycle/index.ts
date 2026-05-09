import { darwinLifecycle } from "./darwin.js";
import { linuxLifecycle, isSystemdAvailable } from "./linux.js";
import { noServiceLifecycle, configureNoService } from "./noService.js";
import type { PlatformLifecycle } from "./types.js";

export type { PlatformLifecycle, InstallOpts, ServiceStatus } from "./types.js";
export { NoSystemdError } from "./types.js";
export {
  pidPath,
  logPath,
  readPid,
  clearPid,
  isPidAlive,
  probePort,
  pollHealth,
  tailFile,
  writeAtomic0600,
  resolveBinaryPath,
  resolveNodePath,
  sha256Hex,
} from "./common.js";

/**
 * Pick the right lifecycle implementation for this platform.
 *
 * - macOS → launchd LaunchAgent
 * - linux with systemd → systemd-user unit
 * - everything else (linux without systemd, BSD, opt-in via flag) →
 *   detached spawn with a PID file (no auto-restart, no auto-start)
 *
 * Pass `dataDir` so the noService fallback knows where to write its PID.
 */
export function getPlatformLifecycle(opts: { dataDir: string; forceNoService?: boolean }): PlatformLifecycle {
  if (opts.forceNoService) {
    configureNoService(opts.dataDir);
    return noServiceLifecycle;
  }
  switch (process.platform) {
    case "darwin":
      return darwinLifecycle;
    case "linux":
      if (isSystemdAvailable()) return linuxLifecycle;
      configureNoService(opts.dataDir);
      return noServiceLifecycle;
    default:
      // Windows-native and the rest fall through. WSL2 reports "linux" so
      // it took the systemd branch above.
      configureNoService(opts.dataDir);
      return noServiceLifecycle;
  }
}
