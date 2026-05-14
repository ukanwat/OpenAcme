import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { setEntry, getEntry } from "./store.js";
import { extractOAuthErrorCode } from "./oauth-openai.js";
import { OAuthRelogin, type OAuthEntry } from "./types.js";

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];

/** Detect whether a token uses Anthropic's OAuth/Bearer scheme. */
export function isAnthropicOAuthToken(token: string): boolean {
  if (!token) return false;
  if (token.startsWith("sk-ant-api")) return false; // regular API key
  if (token.startsWith("sk-ant-")) return true;     // setup token
  if (token.startsWith("cc-")) return true;         // Claude Code OAuth
  if (token.startsWith("eyJ")) return true;         // JWT
  return false;
}

interface ClaudeCodeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number; // milliseconds
  };
}

/**
 * Read Claude Code credentials from disk.
 * Order: ~/.claude/.credentials.json, then ~/.claude.json (older format).
 * macOS keychain entry is also tried as a fallback.
 */
export function readClaudeCodeCredentials(): OAuthEntry | undefined {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const json = JSON.parse(raw) as ClaudeCodeCredentials;
      const entry = fromClaudeCode(json);
      if (entry) return entry;
    } catch {
      /* try next */
    }
  }
  if (process.platform === "darwin") {
    return fromMacOSKeychain();
  }
  return undefined;
}

function fromClaudeCode(json: ClaudeCodeCredentials): OAuthEntry | undefined {
  const oauth = json.claudeAiOauth;
  if (!oauth?.accessToken) return undefined;
  const expiresAt = oauth.expiresAt ? Math.floor(oauth.expiresAt / 1000) : undefined;
  return {
    mode: "claude-code",
    access_token: oauth.accessToken,
    refresh_token: oauth.refreshToken,
    expires_at: expiresAt,
    last_refresh: Math.floor(Date.now() / 1000),
  };
}

function fromMacOSKeychain(): OAuthEntry | undefined {
  const result = spawnSync("security", [
    "find-generic-password",
    "-s", "Claude Code-credentials",
    "-w",
  ], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return undefined;
  try {
    const json = JSON.parse(result.stdout.trim()) as ClaudeCodeCredentials;
    return fromClaudeCode(json);
  } catch {
    return undefined;
  }
}

export interface AnthropicLoginResult {
  source: "claude-code" | "setup-token";
}

/**
 * Sign in with Claude. Tries Claude Code credentials first, then falls back to
 * a user-provided setup token.
 */
export function loginWithClaudeCodeCredentials(dataDir: string): AnthropicLoginResult | null {
  const entry = readClaudeCodeCredentials();
  if (!entry) return null;
  setEntry(dataDir, "anthropic", entry);
  return { source: "claude-code" };
}

/**
 * Best-effort silent re-import of Claude Code credentials when an in-flight
 * request hits a token-shaped or rate-limit failure. Mirrors the read path
 * used by `loginWithClaudeCodeCredentials` but adds two guards:
 *
 *   - Respects an existing **manual setup token** (`mode: "claude-setup-token"`).
 *     The user explicitly pasted that — don't silently swap to Claude Code.
 *   - Idempotent: if the candidate's `access_token` matches the stored
 *     entry, no write happens.
 *
 * Returns the currently-active access token (whether just imported or
 * already in place), or `null` when no Claude Code creds are available
 * or the existing entry is a setup-token we won't touch. Callers
 * compare the return value to the token they actually sent to detect
 * "the user switched Claude accounts in Claude Code; we now have a
 * different bearer to retry with."
 */
export function tryReimportClaudeCode(dataDir: string): string | null {
  const candidate = readClaudeCodeCredentials();
  if (!candidate) return null;
  const current = getEntry(dataDir, "anthropic");
  if (current && current.mode === "claude-setup-token") {
    return null;
  }
  if (!current || current.access_token !== candidate.access_token) {
    setEntry(dataDir, "anthropic", candidate);
  }
  return candidate.access_token;
}

/** Persist a manually-pasted Anthropic setup token (sk-ant-oat-…). */
export function loginWithSetupToken(dataDir: string, token: string): AnthropicLoginResult {
  if (!isAnthropicOAuthToken(token)) {
    throw new Error(
      "That doesn't look like an Anthropic OAuth setup token. " +
      "Get one at https://claude.ai/settings/oauth — it should start with `sk-ant-oat-`."
    );
  }
  const entry: OAuthEntry = {
    mode: "claude-setup-token",
    access_token: token.trim(),
    last_refresh: Math.floor(Date.now() / 1000),
  };
  setEntry(dataDir, "anthropic", entry);
  return { source: "setup-token" };
}

/**
 * Refresh Anthropic OAuth tokens. Setup tokens (no refresh_token) cannot be
 * refreshed — they're long-lived; if invalid, user must regenerate at claude.ai.
 */
export async function refreshAnthropic(dataDir: string): Promise<OAuthEntry> {
  const entry = getEntry(dataDir, "anthropic");
  if (!entry) {
    throw new OAuthRelogin("anthropic", "Not signed in. Run `openacme login --provider anthropic`.");
  }
  if (!entry.refresh_token) {
    // Setup tokens are long-lived; if they're rejected the user must regenerate.
    throw new OAuthRelogin(
      "anthropic",
      "Setup token rejected. Generate a new one at https://claude.ai/settings/oauth and re-run `openacme login --provider anthropic`.",
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: entry.refresh_token,
    client_id: ANTHROPIC_CLIENT_ID,
  });
  let lastError: Error | undefined;
  for (const url of REFRESH_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "claude-cli/2.1.74 (external, cli)",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const code = extractOAuthErrorCode(text);
        const reloginCodes = new Set(["invalid_grant", "invalid_token", "invalid_request"]);
        if (reloginCodes.has(code) || res.status === 400 || res.status === 401 || res.status === 403) {
          throw new OAuthRelogin(
            "anthropic",
            `Claude session expired (HTTP ${res.status}${code ? `, ${code}` : ""}). Run \`openacme login --provider anthropic\`.`,
          );
        }
        lastError = new Error(`Anthropic refresh failed: HTTP ${res.status}. ${text.slice(0, 300)}`);
        continue;
      }
      const t = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!t.access_token) {
        throw new OAuthRelogin("anthropic", "Refresh response missing access_token. Re-login required.");
      }
      const expiresAt = t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : entry.expires_at;
      const next: OAuthEntry = {
        ...entry,
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? entry.refresh_token,
        expires_at: expiresAt,
        last_refresh: Math.floor(Date.now() / 1000),
      };
      setEntry(dataDir, "anthropic", next);
      return next;
    } catch (e) {
      if (e instanceof OAuthRelogin) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error("Anthropic refresh failed at all endpoints");
}
