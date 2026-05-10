import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import { ConfigSchema, type Config } from "./schema.js";

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
 * Load configuration from a YAML file + .env secrets.
 *
 * Resolution order:
 * 1. Load .env from data directory
 * 2. Load config.yaml from data directory
 * 3. Merge with defaults via Zod
 */
export function loadConfig(dataDirOverride?: string): Config {
  const dataDir = resolveDataDir(dataDirOverride);

  // Load .env secrets
  const envPath = path.join(dataDir, ".env");
  if (fs.existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  // Load config.yaml
  const configPath = path.join(dataDir, "config.yaml");
  let rawConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
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
