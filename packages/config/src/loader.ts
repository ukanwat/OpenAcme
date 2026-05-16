import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import {
  ConfigSchema,
  type Config,
  type Provider,
  type AuthMode,
} from "./schema.js";
import { DEFAULT_MODEL_BY_PROVIDER } from "./defaults.js";

/**
 * Resolve `~` to the user's home directory.
 */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the data directory (default: ~/.openacme).
 * Creates it if it doesn't exist.
 */
export function resolveDataDir(dataDir?: string): string {
  const fromEnv = process.env["OPENACME_DATA_DIR"]?.trim();
  const resolved = expandHome(dataDir ?? (fromEnv || "~/.openacme"));
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Detect which provider the user has credentials for. Used by `loadConfig`
 * to bootstrap a starter `config.yaml` on first boot, and reusable by
 * callers that want to know "which provider would the user reasonably
 * default to right now."
 *
 * Priority mirrors `shouldUseOAuth` semantics in `@openacme/llm-provider`:
 * OAuth tokens win over env vars; among env vars, anthropic > openai >
 * openrouter > google (matches the "balanced default" intent in
 * `DEFAULT_MODEL_BY_PROVIDER`).
 *
 * Reads `auth.json` directly (no `@openacme/auth` dep) so config stays a
 * leaf package. Caller is responsible for loading `<dataDir>/.env` into
 * `process.env` first — `loadConfig` already does this before calling.
 */
export function detectConfiguredProvider(
  dataDir: string
): { provider: Provider; auth: AuthMode } | null {
  const authPath = path.join(dataDir, "auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8")) as {
        anthropic?: { access_token?: string };
        openai?: { access_token?: string };
      };
      if (parsed.anthropic?.access_token) {
        return { provider: "anthropic", auth: "oauth" };
      }
      if (parsed.openai?.access_token) {
        return { provider: "openai", auth: "oauth" };
      }
    } catch {
      // Malformed auth.json — fall through to env vars.
    }
  }
  if (process.env["ANTHROPIC_API_KEY"]) {
    return { provider: "anthropic", auth: "api_key" };
  }
  if (process.env["OPENAI_API_KEY"]) {
    return { provider: "openai", auth: "api_key" };
  }
  if (process.env["OPENROUTER_API_KEY"]) {
    return { provider: "openrouter", auth: "api_key" };
  }
  if (process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
    return { provider: "google", auth: "api_key" };
  }
  return null;
}

/**
 * Build the starter config object written to disk on first boot. Returns
 * an empty object when no credentials are detected — Zod fills the rest
 * of the schema and chat surfaces a clean "No model configured" error.
 */
function buildStarterConfig(dataDir: string): Record<string, unknown> {
  const detected = detectConfiguredProvider(dataDir);
  if (!detected) return {};
  const modelId = DEFAULT_MODEL_BY_PROVIDER[detected.provider];
  if (!modelId) return {};
  return {
    model: {
      provider: detected.provider,
      model: modelId,
      auth: detected.auth,
    },
  };
}

/**
 * Load configuration from a YAML file + .env secrets.
 *
 * Resolution order:
 * 1. Load .env from data directory
 * 2. Bootstrap config.yaml if missing — write a starter using
 *    `detectConfiguredProvider` so UI-only first-run users get a real
 *    file on disk with a sensible provider/model.
 * 3. Load config.yaml from data directory
 * 4. Merge with defaults via Zod
 */
export function loadConfig(dataDirOverride?: string): Config {
  const dataDir = resolveDataDir(dataDirOverride);

  // Load .env secrets
  const envPath = path.join(dataDir, ".env");
  if (fs.existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  // Bootstrap config.yaml if missing. `writeRawConfig` is the canonical
  // writer — it strips `dataDir` and matches the format the setup wizard
  // and `/api/keys` use, so the file looks identical regardless of which
  // path produced it.
  const configPath = path.join(dataDir, "config.yaml");
  if (!fs.existsSync(configPath)) {
    writeRawConfig(dataDir, buildStarterConfig(dataDir));
  }
  let rawConfig: Record<string, unknown> = {};
  const content = fs.readFileSync(configPath, "utf-8");
  try {
    rawConfig = (parseYaml(content) as Record<string, unknown>) ?? {};
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to parse config.yaml at ${configPath}: ${message}\n` +
      `Please check your YAML syntax. You can validate it at https://yamlchecker.com/`
    );
  }

  // Parse and validate with defaults
  const config = ConfigSchema.parse({
    ...rawConfig,
    dataDir,
  });

  return config;
}

/**
 * Save configuration to config.yaml in the data directory.
 */
export function saveConfig(config: Config): void {
  const dataDir = resolveDataDir(config.dataDir);
  const configPath = path.join(dataDir, "config.yaml");

  // Don't persist dataDir into the yaml file
  const { dataDir: _, ...toSave } = config;
  const content = stringifyYaml(toSave);
  fs.writeFileSync(configPath, content, "utf-8");
}

/**
 * Read the existing config.yaml as a raw object (no Zod parse, no defaults).
 * Returns {} if the file is absent or unreadable. Used when callers need to
 * preserve user-set keys verbatim — going through `loadConfig` would
 * materialize Zod defaults for every field, indistinguishable from values
 * the user set explicitly.
 */
export function readRawConfig(dataDir: string): Record<string, unknown> {
  const configPath = path.join(resolveDataDir(dataDir), "config.yaml");
  if (!fs.existsSync(configPath)) return {};
  try {
    return (parseYaml(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Write a raw object to config.yaml verbatim (no Zod parse, no defaults).
 * Pair with `readRawConfig` to do "merge, preserve everything else" writes —
 * critical for the setup wizard, which only owns `model` and the first agent
 * but should not clobber `behavior`, `web`, `skills`, or extra agents.
 */
export function writeRawConfig(
  dataDir: string,
  raw: Record<string, unknown>
): void {
  const configPath = path.join(resolveDataDir(dataDir), "config.yaml");
  // Strip dataDir if present — it's runtime-resolved, not persisted.
  const { dataDir: _omit, ...rest } = raw;
  fs.writeFileSync(configPath, stringifyYaml(rest), "utf-8");
}

/**
 * Get the resolved path for a config-relative path.
 * E.g., "state.db" → "/Users/x/.openacme/state.db"
 */
export function resolveConfigPath(config: Config, relativePath: string): string {
  const dataDir = resolveDataDir(config.dataDir);
  return path.join(dataDir, relativePath);
}
