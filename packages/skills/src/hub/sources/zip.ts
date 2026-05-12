import AdmZip from "adm-zip";
import type { SkillBundleFile } from "../types.js";
import { validateBundlePath } from "../path-validation.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

/**
 * Extract a ZIP buffer into bundle files, enforcing size + count caps
 * *while* iterating header entries (not post-extract) so a zip bomb
 * can't expand past MAX_TOTAL_BYTES.
 *
 * The decompressed-size header is per-entry — we sum it as we read each
 * one, abort on overflow, and skip path-traversal entries.
 */
export function extractZipBundle(buffer: Buffer): SkillBundleFile[] {
  const zip = new AdmZip(buffer);
  const out: SkillBundleFile[] = [];
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (out.length >= MAX_FILES) break;
    if (entry.isDirectory) continue;
    const rel = entry.entryName.replace(/^\/+/, "");
    try {
      validateBundlePath(rel);
    } catch {
      continue;
    }
    const declaredSize = entry.header.size;
    if (declaredSize > MAX_TOTAL_BYTES) {
      throw new Error(`zip entry too large: ${rel}`);
    }
    if (total + declaredSize > MAX_TOTAL_BYTES) {
      throw new Error(`zip bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    const data = entry.getData();
    total += data.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`zip bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    out.push({ relPath: rel, bytes: new Uint8Array(data) });
  }
  return out;
}
