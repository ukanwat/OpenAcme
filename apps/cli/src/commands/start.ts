import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  loadConfig,
  resolveDataDir,
  ensureSecret,
  readSecret,
  readRawConfig,
  writeRawConfig,
} from "@openacme/config";
import {
  getPlatformLifecycle,
  logPath,
  pidPath,
  pollHealth,
  resolveBinaryPath,
  resolveNodePath,
  writeAtomic0600,
  clearPid,
} from "../lifecycle/index.js";

interface StartOpts {
  dataDir?: string;
  noBrowser?: boolean;
  noService?: boolean;
  expose?: boolean;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" :
    "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function userFacingUrl(host: string, port: number): string {
  const display = isLoopback(host) ? "localhost" : host === "0.0.0.0" || host === "::" ? "localhost" : host;
  return `http://${display}:${port}`;
}

export async function startCommand(opts: StartOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);

  // --expose: flip server.host to 0.0.0.0 before loading config so the
  // rest of the function sees the updated value.
  if (opts.expose) {
    const raw = readRawConfig(dataDir);
    const server = (raw.server && typeof raw.server === "object")
      ? { ...(raw.server as Record<string, unknown>) }
      : {};
    if (server.host !== "0.0.0.0") {
      server.host = "0.0.0.0";
      raw.server = server;
      writeRawConfig(dataDir, raw);
      console.log("✓ updated config.server.host = 0.0.0.0");
    } else {
      console.log("✓ config.server.host already 0.0.0.0");
    }
  }

  const config = loadConfig(dataDir);
  const host = config.server.host;
  const port = config.server.port;
  const url = userFacingUrl(host, port);

  // No agent gate here — the daemon's `ensureManagedAgents()` materializes
  // the Acme platform agent on first boot. If provider auth is missing
  // the daemon still boots; chat fails with a self-explanatory auth error
  // which is the right surface for that case.

  // Non-loopback binding requires a secret for the auth middleware.
  let freshSecret: string | null = null;
  if (!isLoopback(host)) {
    const before = readSecret(dataDir);
    const secret = ensureSecret(dataDir);
    if (!before) freshSecret = secret;
  }

  const lp = logPath(dataDir);
  if (!fs.existsSync(lp)) writeAtomic0600(lp, "");

  const lifecycle = getPlatformLifecycle({ dataDir, forceNoService: opts.noService });

  const initialStatus = await lifecycle.status();
  if (initialStatus.running) {
    if (!opts.expose) {
      // Idempotent: already running, nothing to do.
      console.log(`✓ openacme is already running${initialStatus.pid ? ` (pid ${initialStatus.pid})` : ""} at ${url}`);
      if (process.stdout.isTTY && !opts.noBrowser) openBrowser(url);
      return;
    }
    // --expose with a running daemon: restart so it picks up the new bind.
    console.log("⠋ restarting daemon to apply new bind...");
    await lifecycle.stopService();
    clearPid(dataDir);
    await new Promise((r) => setTimeout(r, 300));
  }

  const binPath = resolveBinaryPath();
  const nodePath = resolveNodePath();

  const install = await lifecycle.installUnit({ binPath, nodePath, dataDir, logPath: lp, host, port });
  if (install.wrote) {
    if (lifecycle.kind === "no-service") {
      console.log("✓ no-service mode (PID file only; no auto-restart)");
    } else {
      console.log(`✓ wrote ${lifecycle.kind} unit (${install.path})`);
    }
  }

  await lifecycle.startService();
  if (lifecycle.kind !== "no-service") {
    console.log(`✓ service started via ${lifecycle.kind}`);
  }

  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  process.stdout.write("⠋ waiting for daemon to come up...");
  const healthy = await pollHealth(healthUrl, 10_000);
  process.stdout.write("\r");
  if (!healthy) {
    console.error("✗ daemon did not respond on /api/health within 10s");
    console.error(`  check the log: openacme logs (file: ${lp})`);
    process.exit(1);
  }

  const finalStatus = await lifecycle.status();
  const pidLine = finalStatus.pid ? ` (pid ${finalStatus.pid})` : "";
  console.log(`✓ daemon listening on ${url}${pidLine}`);

  if (opts.expose) {
    const secret = readSecret(dataDir) ?? "";
    console.log("");
    console.log("  Share this secret with devices that need access:");
    console.log("");
    console.log(`      ${secret}`);
    console.log("");
    console.log("  Reprint:  openacme secret");
    console.log("  Rotate:   openacme secret rotate");
    console.log("  Tunnel:   ngrok http 3210   (paste the secret on first device load)");
  } else if (freshSecret) {
    console.log("");
    console.log("  Bound non-loopback — share this secret with devices:");
    console.log("");
    console.log(`      ${freshSecret}`);
    console.log("");
    console.log("  Reprint:  openacme secret");
    console.log("  Rotate:   openacme secret rotate");
  }

  console.log("");
  console.log(`  status:  openacme status`);
  console.log(`  logs:    openacme logs -f`);
  console.log(`  stop:    openacme stop`);
  console.log(`  open:    ${url}`);

  if (finalStatus.pid) {
    writeAtomic0600(pidPath(dataDir), String(finalStatus.pid));
  }

  if (process.stdout.isTTY && !opts.noBrowser) {
    setTimeout(() => openBrowser(url), 500);
  }
}
