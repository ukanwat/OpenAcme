/**
 * OAuth token entry stored in ~/.openacme/auth.json.
 * `expires_at` is a Unix timestamp in seconds (UTC).
 */
export interface OAuthEntry {
  mode: "chatgpt" | "claude-code" | "claude-setup-token";
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
  account_id?: string;
  last_refresh?: number;
}

export interface AuthFile {
  version: 1;
  openai?: OAuthEntry;
  anthropic?: OAuthEntry;
}

export type OAuthProvider = "openai" | "anthropic";

/**
 * Thrown when a stored OAuth session is unrecoverable (refresh token revoked,
 * already used, or never present). The CLI catches this and prompts the user
 * to run `openacme login` again.
 */
export class OAuthRelogin extends Error {
  constructor(
    public readonly provider: OAuthProvider,
    message: string,
  ) {
    super(message);
    this.name = "OAuthRelogin";
  }
}
