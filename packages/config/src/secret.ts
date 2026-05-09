import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { writeAtomic0600 } from "./atomic.js";

const FILE_NAME = "secret";

export function secretPath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

/**
 * 32 random bytes, hex-encoded (64 chars). Plenty of entropy and
 * trivially safe in cookies, headers, and URLs.
 */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function readSecret(dataDir: string): string | null {
  try {
    const raw = fs.readFileSync(secretPath(dataDir), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeSecret(dataDir: string, value: string): void {
  writeAtomic0600(secretPath(dataDir), value);
}

/**
 * Read the secret if present; otherwise generate one, persist it, and
 * return it. Called by the daemon when binding non-loopback so the user
 * always has a value to share. Loopback-only daemons can skip this — the
 * loopback bypass makes a missing secret harmless.
 */
export function ensureSecret(dataDir: string): string {
  const existing = readSecret(dataDir);
  if (existing) return existing;
  const fresh = generateSecret();
  writeSecret(dataDir, fresh);
  return fresh;
}

export function clearSecret(dataDir: string): void {
  try { fs.unlinkSync(secretPath(dataDir)); } catch { /* ignore */ }
}
