/**
 * Bundle-file path validation. Every `relPath` is untrusted input until
 * both this AND a post-`path.resolve` check against the staging root pass.
 */

const MAX_PATH_LEN = 512;

export class InvalidBundlePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBundlePathError";
  }
}

export function validateBundlePath(relPath: string): void {
  if (!relPath) {
    throw new InvalidBundlePathError("empty path");
  }
  if (relPath.length > MAX_PATH_LEN) {
    throw new InvalidBundlePathError(`path too long: ${relPath.slice(0, 40)}…`);
  }
  if (relPath.includes("\0")) {
    throw new InvalidBundlePathError(`NUL byte in path: ${relPath}`);
  }
  // Reject Windows drive-letter prefixes (C:\, c:/, etc.) — defense in
  // depth even on POSIX since we use POSIX paths throughout.
  if (/^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new InvalidBundlePathError(`drive-letter prefix not allowed: ${relPath}`);
  }
  // Normalize separators and split.
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new InvalidBundlePathError(`absolute path not allowed: ${relPath}`);
  }
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new InvalidBundlePathError(`parent traversal not allowed: ${relPath}`);
    }
  }
}

/** Kebab-case, lowercase alphanumeric + single hyphens, no leading/trailing hyphen. */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class InvalidSkillNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSkillNameError";
  }
}

export function validateSkillName(name: string): void {
  if (!name) {
    throw new InvalidSkillNameError("skill name is empty");
  }
  if (name.length > 64) {
    throw new InvalidSkillNameError(`skill name too long: ${name}`);
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new InvalidSkillNameError(
      `skill name must be kebab-case (a-z, 0-9, single hyphens): ${name}`
    );
  }
}

/** Coerce a raw candidate (frontmatter `name`, URL slug, folder) to kebab-case. */
export function safeName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
