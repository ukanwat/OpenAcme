import { spawnSync } from "node:child_process";

/**
 * GitHub API auth. Order: `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`
 * (5 s timeout) → unauthenticated (60 req/hr public limit).
 */
export class GitHubAuth {
  private cachedToken: string | null | undefined;

  /** Returns a token or null if none is reachable. */
  resolveToken(): string | null {
    if (this.cachedToken !== undefined) return this.cachedToken;
    const env = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (env && env.trim()) {
      this.cachedToken = env.trim();
      return this.cachedToken;
    }
    try {
      const r = spawnSync("gh", ["auth", "token"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r.status === 0 && r.stdout.trim()) {
        this.cachedToken = r.stdout.trim();
        return this.cachedToken;
      }
    } catch {
      // gh not installed / not in PATH — fall through
    }
    this.cachedToken = null;
    return null;
  }

  headers(extra?: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "openacme-skills-hub",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
    const tok = this.resolveToken();
    if (tok) out["Authorization"] = `Bearer ${tok}`;
    return out;
  }
}
