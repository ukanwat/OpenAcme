import * as crypto from "node:crypto";
import type { SkillBundleFile } from "./types.js";

/**
 * Stable content hash over a SkillBundle's files. Sorted by `relPath`
 * so the hash is order-independent.
 *
 * Format `sha256:<hex16>` — 16 hex chars is enough for change detection;
 * collision risk on a few hundred installed skills is negligible.
 */
export function sha256OfBundle(files: SkillBundleFile[]): string {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  const hasher = crypto.createHash("sha256");
  for (const f of sorted) {
    hasher.update(f.relPath, "utf8");
    hasher.update("\0");
    hasher.update(f.bytes);
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex").slice(0, 16)}`;
}

/**
 * Hex sha256 of an arbitrary string. Used for index-cache key naming.
 */
export function sha256Key(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}
