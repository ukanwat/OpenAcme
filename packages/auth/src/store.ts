import * as fs from "node:fs";
import * as path from "node:path";
import type { AuthFile, OAuthEntry, OAuthProvider } from "./types.js";

const FILE_NAME = "auth.json";

function authPath(dataDir: string): string {
  return path.join(dataDir, FILE_NAME);
}

export function readAuthFile(dataDir: string): AuthFile {
  const p = authPath(dataDir);
  if (!fs.existsSync(p)) return { version: 1 };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AuthFile>;
    return { version: 1, openai: parsed.openai, anthropic: parsed.anthropic };
  } catch {
    return { version: 1 };
  }
}

/**
 * Atomic write: write to a tempfile in the same dir, then rename.
 * On POSIX, chmod the tempfile 0600 before rename so the rename inherits it.
 */
export function writeAuthFile(dataDir: string, file: AuthFile): void {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const target = authPath(dataDir);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  }
  fs.renameSync(tmp, target);
  if (process.platform !== "win32") {
    try { fs.chmodSync(target, 0o600); } catch { /* best-effort */ }
  }
}

export function getEntry(dataDir: string, provider: OAuthProvider): OAuthEntry | undefined {
  return readAuthFile(dataDir)[provider];
}

export function setEntry(dataDir: string, provider: OAuthProvider, entry: OAuthEntry): void {
  const file = readAuthFile(dataDir);
  file[provider] = entry;
  writeAuthFile(dataDir, file);
}

export function clearEntry(dataDir: string, provider: OAuthProvider): void {
  const file = readAuthFile(dataDir);
  delete file[provider];
  writeAuthFile(dataDir, file);
}
