import {
  generateSecret,
  readSecret,
  resolveDataDir,
  writeSecret,
} from "@openacme/config";
import { restartCommand } from "./restart.js";
import { getPlatformLifecycle } from "../lifecycle/index.js";

interface SecretOpts {
  dataDir?: string;
  noService?: boolean;
}

export async function secretShowCommand(opts: SecretOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const existing = readSecret(dataDir);
  if (existing) {
    console.log(existing);
    return;
  }
  console.error("No secret on disk yet.");
  console.error("Run `openacme expose` to bind non-loopback and generate one,");
  console.error("or `openacme secret rotate` to generate one without exposing.");
  process.exit(1);
}

export async function secretRotateCommand(opts: SecretOpts): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir);
  const fresh = generateSecret();
  writeSecret(dataDir, fresh);
  console.log("✓ rotated. existing browser sessions are now invalid.");
  console.log("");
  console.log(`      ${fresh}`);
  console.log("");

  // If the daemon is running, restart so the in-memory secret hash refreshes.
  const lifecycle = getPlatformLifecycle({ dataDir, forceNoService: opts.noService });
  const status = await lifecycle.status();
  if (status.running) {
    console.log("⠋ restarting daemon to apply...");
    await restartCommand({ dataDir, noBrowser: true, noService: opts.noService });
  }
}
