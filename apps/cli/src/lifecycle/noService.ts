import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { clearPid, isPidAlive, logPath, pidPath, readPid, writeAtomic0600 } from "./common.js";
import type { InstallOpts, PlatformLifecycle, ServiceStatus } from "./types.js";

let dataDirRef = "";

/**
 * Fallback for systems without launchd or systemd-user (Alpine OpenRC, plain
 * containers, --no-service flag). Spawns a detached child and writes a PID
 * file. No auto-restart, no auto-start at login — the user is responsible for
 * relaunching after reboots.
 */
export const noServiceLifecycle: PlatformLifecycle = {
  kind: "no-service",

  unitPath(): string {
    return "(none — no-service mode)";
  },

  async installUnit(opts: InstallOpts): Promise<{ wrote: boolean; path: string }> {
    dataDirRef = opts.dataDir;
    return { wrote: false, path: "(no-service)" };
  },

  async uninstallUnit(): Promise<void> {
    // nothing to do
  },

  async startService(): Promise<void> {
    if (!dataDirRef) {
      throw new Error("noServiceLifecycle.startService called before installUnit");
    }
    const lp = logPath(dataDirRef);
    const pp = pidPath(dataDirRef);
    // Make sure the log file exists with restrictive permissions before we
    // hand it to the child as an FD. Otherwise the kernel creates it with
    // umask defaults.
    if (!fs.existsSync(lp)) writeAtomic0600(lp, "");
    const fd = fs.openSync(lp, "a");
    const child = spawn(
      // We re-exec via the same node + bin path that the controller is using.
      process.execPath,
      [process.argv[1] ?? "", "__serve"],
      {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, OPENACME_DATA_DIR: dataDirRef },
      }
    );
    // Child inherits its own copy of the fd — close the parent's copy so we
    // don't hold the log file open in the controller process.
    fs.closeSync(fd);
    child.unref();
    if (child.pid === undefined) {
      throw new Error("Failed to spawn detached daemon child");
    }
    writeAtomic0600(pp, String(child.pid));
  },

  async stopService(): Promise<void> {
    if (!dataDirRef) return;
    const pid = readPid(dataDirRef);
    if (pid === null) return;
    try {
      process.kill(pid, "SIGTERM");
      // Wait briefly, then SIGKILL if still alive.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!isPidAlive(pid)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
    clearPid(dataDirRef);
  },

  async status(): Promise<ServiceStatus> {
    if (!dataDirRef) return { running: false, unitInstalled: false };
    const pid = readPid(dataDirRef);
    if (pid === null) return { running: false, unitInstalled: false };
    if (!isPidAlive(pid)) {
      clearPid(dataDirRef);
      return { running: false, unitInstalled: false };
    }
    return { running: true, pid, unitInstalled: false };
  },
};

/** Bind the no-service lifecycle to a specific data dir. */
export function configureNoService(dataDir: string): void {
  dataDirRef = dataDir;
}
