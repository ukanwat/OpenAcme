import * as fs from "node:fs";
import * as path from "node:path";

const MARKER = ".last-cli-version";

/**
 * Read the recorded version the daemon last successfully booted under.
 * Returns undefined when the marker is absent (fresh install) or
 * unreadable (treated as "missing"; the post-update hook re-runs
 * harmlessly on the next boot).
 */
export function readLastVersion(dataDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir, MARKER), "utf-8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

/**
 * Record the version the daemon just successfully booted under so the
 * post-update hook doesn't re-run on every restart. Atomic via
 * write-then-rename — a torn write would just look like a missing
 * marker, which is the safe fallback. Assumes `dataDir` exists (always
 * true by the time the daemon boots).
 */
export function writeLastVersion(dataDir: string, version: string): void {
  const final = path.join(dataDir, MARKER);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, `${version}\n`, "utf-8");
  fs.renameSync(tmp, final);
}
