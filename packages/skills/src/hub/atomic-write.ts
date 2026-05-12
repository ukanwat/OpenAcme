import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Atomic write: stage to `<dir>/<name>.<pid>.<ts>.tmp`, then rename over
 * the target. Rename is atomic on POSIX when the source and destination
 * sit on the same filesystem, which they do because we stage in the
 * same directory.
 *
 * Used for lockfile, taps, and index-cache writes so a torn write at
 * process death never leaves a partial JSON file at the canonical path.
 */
export function atomicWriteSync(filePath: string, contents: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}
