import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { readAuthFile } from "@openacme/auth";
import { listProviders } from "./registry.js";

export type CredentialSource = "api_key" | "oauth";

export interface ProviderCredentials {
  configured: Record<string, boolean>;
  sources: Record<string, CredentialSource>;
  envPath: string;
}

/**
 * Detect which providers have credentials available, combining:
 *   - process.env (env var name from ProviderInfo.envVar)
 *   - dataDir/.env (so keys saved by the web UI are picked up without restart)
 *   - auth.json (OAuth tokens for openai/anthropic)
 *
 * No-key providers (ollama, custom) are not auto-configured here — the picker
 * surfaces them only when an existing agent already uses one (via the
 * "current provider" fallback), which avoids advertising a local server we
 * have no way to verify is actually running.
 */
export function detectProviderCredentials(dataDir: string): ProviderCredentials {
  const envPath = path.join(dataDir, ".env");
  let envVars: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    envVars = dotenv.parse(fs.readFileSync(envPath, "utf-8"));
  }
  const authFile = readAuthFile(dataDir);
  const configured: Record<string, boolean> = {};
  const sources: Record<string, CredentialSource> = {};

  for (const p of listProviders()) {
    const hasApiKey =
      !!p.envVar && (!!process.env[p.envVar] || !!envVars[p.envVar]);
    const hasOAuth =
      (p.id === "openai" || p.id === "anthropic") &&
      !!authFile[p.id]?.access_token;
    configured[p.id] = hasApiKey || hasOAuth;
    if (hasApiKey) sources[p.id] = "api_key";
    else if (hasOAuth) sources[p.id] = "oauth";
  }
  return { configured, sources, envPath };
}
