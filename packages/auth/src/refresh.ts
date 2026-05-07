import { getEntry, clearEntry } from "./store.js";
import { refreshOpenAI } from "./oauth-openai.js";
import { refreshAnthropic } from "./oauth-anthropic.js";
import { OAuthRelogin, type OAuthEntry, type OAuthProvider } from "./types.js";

const REFRESH_SKEW_SECONDS = 120;

/**
 * Per-provider in-flight refresh promise. Concurrent callers all await the
 * same promise so we never fire two refresh requests with the same
 * (rotating) refresh_token — that triggers `refresh_token_reused`.
 */
const inFlight: Partial<Record<OAuthProvider, Promise<OAuthEntry>>> = {};

function isExpiringSoon(entry: OAuthEntry): boolean {
  if (!entry.expires_at) return false;
  return entry.expires_at - Math.floor(Date.now() / 1000) < REFRESH_SKEW_SECONDS;
}

async function refreshOne(provider: OAuthProvider, dataDir: string): Promise<OAuthEntry> {
  if (provider === "openai") return refreshOpenAI(dataDir);
  return refreshAnthropic(dataDir);
}

/**
 * Returns a fresh access token for the given provider, refreshing if needed.
 * Throws OAuthRelogin if the session is unrecoverable.
 */
export async function getOAuthToken(
  provider: OAuthProvider,
  dataDir: string,
): Promise<{ token: string; accountId?: string }> {
  let entry = getEntry(dataDir, provider);
  if (!entry) {
    throw new OAuthRelogin(provider, `Not signed in. Run \`openacme login --provider ${provider}\`.`);
  }

  if (isExpiringSoon(entry)) {
    let pending = inFlight[provider];
    if (!pending) {
      pending = refreshOne(provider, dataDir).finally(() => { delete inFlight[provider]; });
      inFlight[provider] = pending;
    }
    try {
      entry = await pending;
    } catch (e) {
      if (e instanceof OAuthRelogin) {
        clearEntry(dataDir, provider);
      }
      throw e;
    }
  }

  return { token: entry.access_token, accountId: entry.account_id };
}
