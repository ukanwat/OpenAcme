import * as path from "node:path";

/**
 * Hub state under `<skillsDir>/.hub/` — the dot-prefix keeps SkillRegistry
 * from accidentally loading hub state as a skill.
 */

export function hubDir(skillsDir: string): string {
  return path.join(skillsDir, ".hub");
}

export function lockFile(skillsDir: string): string {
  return path.join(hubDir(skillsDir), "lock.json");
}

export function tapsFile(skillsDir: string): string {
  return path.join(hubDir(skillsDir), "taps.json");
}

export function auditLog(skillsDir: string): string {
  return path.join(hubDir(skillsDir), "audit.log");
}

export function indexCacheDir(skillsDir: string): string {
  return path.join(hubDir(skillsDir), "index-cache");
}

export function stagingDir(skillsDir: string): string {
  return path.join(hubDir(skillsDir), "staging");
}

export function skillTargetDir(skillsDir: string, safeName: string): string {
  return path.join(skillsDir, safeName);
}
