import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCmd } from "./common.js";
import { NoSystemdError, type InstallOpts, type PlatformLifecycle, type ServiceStatus } from "./types.js";

const UNIT_NAME = "openacme.service";

function unitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", UNIT_NAME);
}

export function isSystemdAvailable(): boolean {
  return fs.existsSync("/run/systemd/system");
}

function renderUnit(opts: InstallOpts): string {
  // ExecStart is not shell-parsed by systemd — quote individual tokens so
  // paths containing spaces work correctly. Environment and file directives
  // are not tokenized, so bare paths are fine there.
  const q = (s: string) => `"${s.replaceAll('"', '\\"')}"`;
  return `[Unit]
Description=OpenAcme agent daemon
After=network.target

[Service]
Type=simple
ExecStart=${q(opts.nodePath)} ${q(opts.binPath)} __serve
Environment=OPENACME_DATA_DIR=${opts.dataDir}
WorkingDirectory=${opts.dataDir}
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function ensureSystemd(): void {
  if (!isSystemdAvailable()) throw new NoSystemdError();
}

export const linuxLifecycle: PlatformLifecycle = {
  kind: "systemd-user",

  unitPath(): string {
    return unitPath();
  },

  async installUnit(opts: InstallOpts): Promise<{ wrote: boolean; path: string }> {
    ensureSystemd();
    const target = unitPath();
    const next = renderUnit(opts);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : null;
    if (existing === next) return { wrote: false, path: target };
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, next, { encoding: "utf-8" });
    // daemon-reload picks up new/changed units. Always run on rewrite —
    // skipping it leaves systemd serving the old ExecStart even after
    // we updated the file.
    const reload = await runCmd("systemctl", ["--user", "daemon-reload"]);
    if (reload.code !== 0) {
      throw new Error(`systemctl daemon-reload failed: ${reload.stderr.trim()}`);
    }
    return { wrote: true, path: target };
  },

  async uninstallUnit(): Promise<void> {
    await runCmd("systemctl", ["--user", "disable", "--now", UNIT_NAME]).catch(() => undefined);
    try { fs.unlinkSync(unitPath()); } catch { /* ignore */ }
    await runCmd("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  },

  async startService(): Promise<void> {
    ensureSystemd();
    // enable --now: enable on boot/login + start now. Idempotent.
    const res = await runCmd("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
    if (res.code !== 0) {
      throw new Error(`systemctl enable --now failed: ${res.stderr.trim()}`);
    }
  },

  async stopService(): Promise<void> {
    if (!isSystemdAvailable()) return;
    const res = await runCmd("systemctl", ["--user", "stop", UNIT_NAME]);
    void res;
  },

  async status(): Promise<ServiceStatus> {
    const installed = fs.existsSync(unitPath());
    if (!installed) return { running: false, unitInstalled: false };
    if (!isSystemdAvailable()) return { running: false, unitInstalled: true };
    const res = await runCmd("systemctl", [
      "--user",
      "show",
      UNIT_NAME,
      "--property=ActiveState,MainPID,ExecMainStartTimestamp",
    ]);
    if (res.code !== 0) return { running: false, unitInstalled: true };
    const props = new Map<string, string>();
    for (const line of res.stdout.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
    }
    const running = props.get("ActiveState") === "active";
    const pidStr = props.get("MainPID");
    const pid = pidStr ? Number.parseInt(pidStr, 10) : undefined;
    let startedAt: Date | undefined;
    const ts = props.get("ExecMainStartTimestamp");
    if (ts && ts !== "n/a") {
      const d = new Date(ts);
      if (!Number.isNaN(d.getTime())) startedAt = d;
    }
    return {
      running,
      pid: pid && pid > 0 ? pid : undefined,
      startedAt,
      unitInstalled: true,
    };
  },
};
