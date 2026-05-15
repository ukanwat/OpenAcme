import * as fs from "node:fs";
import { AuditRowSchema } from "./schemas.js";
import { auditLog, hubDir } from "./paths.js";
import type { AuditAction, AuditRow } from "./types.js";

export function appendAuditLog(
  skillsDir: string,
  row: Omit<AuditRow, "ts"> & { ts?: string }
): void {
  const full: AuditRow = {
    ts: row.ts ?? new Date().toISOString(),
    ...row,
  } as AuditRow;
  const validated = AuditRowSchema.parse(full);
  fs.mkdirSync(hubDir(skillsDir), { recursive: true });
  fs.appendFileSync(auditLog(skillsDir), JSON.stringify(validated) + "\n", "utf-8");
}

export function readAuditLog(
  skillsDir: string,
  opts: { limit?: number; action?: AuditAction } = {}
): AuditRow[] {
  const fp = auditLog(skillsDir);
  if (!fs.existsSync(fp)) return [];
  const text = fs.readFileSync(fp, "utf-8");
  const lines = text.split("\n").filter(Boolean);
  const out: AuditRow[] = [];
  // Read newest-first; we tail by walking backward.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    try {
      const parsed = AuditRowSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      if (opts.action && parsed.data.action !== opts.action) continue;
      out.push(parsed.data);
      if (opts.limit && out.length >= opts.limit) break;
    } catch {
      // Skip malformed rows silently — log is append-only and a torn
      // write at process death shouldn't poison the tail.
    }
  }
  return out;
}
