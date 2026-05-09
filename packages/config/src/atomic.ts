import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write a file atomically with mode 0600. Same pattern used by
 * `packages/auth/src/store.ts` for auth.json — temp file in the same dir,
 * chmod, rename. Atomic rename guarantees readers see either the old
 * complete file or the new one, never a partial write.
 */
export function writeAtomic0600(target: string, contents: string | Buffer): void {
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  }
  fs.renameSync(tmp, target);
  if (process.platform !== "win32") {
    try { fs.chmodSync(target, 0o600); } catch { /* best-effort */ }
  }
}
