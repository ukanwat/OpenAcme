import { generateChallenge, generateState, generateVerifier } from "./pkce.js";
import { awaitLoopbackCallback } from "./loopback.js";
import { openBrowser } from "./browser.js";
import { setEntry, getEntry } from "./store.js";
import { extractChatGptAccountId, extractEmail } from "./jwt.js";
import { OAuthRelogin, type OAuthEntry } from "./types.js";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REDIRECT_PORT = 1455;
const BROWSER_REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const SCOPES = "openid profile email offline_access";
export const OPENAI_INFERENCE_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface OpenAILoginOptions {
  dataDir: string;
  flow?: "browser" | "device";
  /** Callback fired after the URL is built but before browser is opened —
   *  lets the CLI print the URL with nicer formatting. */
  onAuthUrl?: (url: string) => void;
  /** Callback fired in device flow after user_code is received. */
  onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
}

export interface OpenAILoginResult {
  email?: string;
  accountId?: string;
  flow: "browser" | "device";
}

/** Run the appropriate OpenAI OAuth flow and persist tokens. */
export async function oauthLoginOpenAI(opts: OpenAILoginOptions): Promise<OpenAILoginResult> {
  const flow = opts.flow ?? "browser";
  if (flow === "device") {
    return runDeviceFlow(opts);
  }
  return runBrowserFlow(opts);
}

async function runBrowserFlow(opts: OpenAILoginOptions): Promise<OpenAILoginResult> {
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);
  const state = generateState();

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", OPENAI_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", BROWSER_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("id_token_add_organizations", "true");
  authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authorizeUrl.searchParams.set("originator", "openacme");

  const url = authorizeUrl.toString();
  opts.onAuthUrl?.(url);

  // Start the loopback server first so it's ready before the browser opens.
  const callbackPromise = awaitLoopbackCallback({ port: REDIRECT_PORT, expectedState: state });
  openBrowser(url);

  const { code } = await callbackPromise;

  const tokens = await exchangeAuthCode({
    code,
    code_verifier: verifier,
    redirect_uri: BROWSER_REDIRECT_URI,
  });

  return persistAndReport(opts.dataDir, tokens, "browser");
}

async function runDeviceFlow(opts: OpenAILoginOptions): Promise<OpenAILoginResult> {
  // Step 1: request user code
  const userCodeRes = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
  });
  if (!userCodeRes.ok) {
    throw new Error(`Device-code request failed: HTTP ${userCodeRes.status}`);
  }
  const userCodeData = await userCodeRes.json() as {
    user_code?: string;
    device_auth_id?: string;
    interval?: string | number;
  };
  const userCode = userCodeData.user_code ?? "";
  const deviceAuthId = userCodeData.device_auth_id ?? "";
  let pollIntervalSec = Math.max(3, Number(userCodeData.interval ?? 5));
  if (!userCode || !deviceAuthId) {
    throw new Error("Device-code response missing user_code or device_auth_id");
  }

  const verificationUri = `${ISSUER}/codex/device`;
  opts.onDeviceCode?.({ userCode, verificationUri });

  // Step 2: poll for authorization
  const deadline = Date.now() + 15 * 60_000;
  let authorizationCode = "";
  let codeVerifier = "";
  while (Date.now() < deadline) {
    await sleep(pollIntervalSec * 1000);
    const pollRes = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
    if (pollRes.status === 200) {
      const json = await pollRes.json() as { authorization_code?: string; code_verifier?: string };
      authorizationCode = (json.authorization_code ?? "").trim();
      codeVerifier = (json.code_verifier ?? "").trim();
      if (!authorizationCode || !codeVerifier) {
        throw new Error("Device-code response missing authorization_code or code_verifier");
      }
      break;
    }
    // 403/404 are "not authorized yet" — keep polling. 429 means slow_down.
    if (pollRes.status === 403 || pollRes.status === 404) continue;
    if (pollRes.status === 429) {
      pollIntervalSec = Math.min(pollIntervalSec + 1, 30);
      continue;
    }
    throw new Error(`Device-code polling failed: HTTP ${pollRes.status}`);
  }
  if (!authorizationCode || !codeVerifier) {
    throw new Error("Device-code login timed out after 15 minutes");
  }

  const tokens = await exchangeAuthCode({
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  });

  return persistAndReport(opts.dataDir, tokens, "device");
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function exchangeAuthCode(args: {
  code: string;
  code_verifier: string;
  redirect_uri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirect_uri,
    client_id: OPENAI_CLIENT_ID,
    code_verifier: args.code_verifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${res.status} ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

function persistAndReport(dataDir: string, t: TokenResponse, flow: "browser" | "device"): OpenAILoginResult {
  if (!t.access_token) {
    throw new Error("Token response did not contain access_token");
  }
  const expiresAt = t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : undefined;
  const accountId = extractChatGptAccountId(t.access_token, t.id_token);
  const email = extractEmail(t.id_token);
  const entry: OAuthEntry = {
    mode: "chatgpt",
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    id_token: t.id_token,
    expires_at: expiresAt,
    account_id: accountId,
    last_refresh: Math.floor(Date.now() / 1000),
  };
  setEntry(dataDir, "openai", entry);
  return { email, accountId, flow };
}

/**
 * Refresh OpenAI access token using the stored refresh_token.
 * Throws OAuthRelogin on terminal failures.
 */
export async function refreshOpenAI(dataDir: string): Promise<OAuthEntry> {
  const entry = getEntry(dataDir, "openai");
  if (!entry || !entry.refresh_token) {
    throw new OAuthRelogin("openai", "No refresh token. Run `openacme login --provider openai`.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: entry.refresh_token,
    client_id: OPENAI_CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const code = extractOAuthErrorCode(text);
    const reloginCodes = new Set([
      "invalid_grant", "invalid_token", "invalid_request", "refresh_token_reused",
    ]);
    if (reloginCodes.has(code) || res.status === 400 || res.status === 401 || res.status === 403) {
      const reason = code === "refresh_token_reused"
        ? "Your ChatGPT refresh token was already consumed by another client (Codex CLI / VS Code extension)."
        : `ChatGPT session expired (HTTP ${res.status}${code ? `, ${code}` : ""}).`;
      throw new OAuthRelogin(
        "openai",
        `${reason} Run \`openacme login --provider openai\`.`,
      );
    }
    throw new Error(`Refresh failed: HTTP ${res.status}. ${text.slice(0, 300)}`);
  }
  const t = await res.json() as TokenResponse;
  if (!t.access_token) {
    throw new OAuthRelogin("openai", "Refresh response missing access_token. Re-login required.");
  }
  const expiresAt = t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : entry.expires_at;
  const next: OAuthEntry = {
    ...entry,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? entry.refresh_token, // refresh_token rotates
    id_token: t.id_token ?? entry.id_token,
    expires_at: expiresAt,
    account_id: extractChatGptAccountId(t.access_token, t.id_token ?? entry.id_token) ?? entry.account_id,
    last_refresh: Math.floor(Date.now() / 1000),
  };
  setEntry(dataDir, "openai", next);
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract a useful OAuth error code from a token-endpoint failure body.
 * Handles both the OAuth spec shape `{error: "code", error_description: "…"}`
 * and OpenAI's nested shape `{error: {code: "…", message: "…"}}`.
 */
export function extractOAuthErrorCode(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const err = parsed.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const obj = err as Record<string, unknown>;
      const code = obj["code"] ?? obj["type"];
      if (typeof code === "string") return code;
    }
  } catch { /* not JSON */ }
  return "";
}
