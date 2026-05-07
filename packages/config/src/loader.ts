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
  const resolved = expandHome(dataDir ?? "~/.openacme");
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
 * Get the resolved path for a config-relative path.
 * E.g., "state.db" → "/Users/x/.openacme/state.db"
 */
export function resolveConfigPath(config: Config, relativePath: string): string {
  const dataDir = resolveDataDir(config.dataDir);
  return path.join(dataDir, relativePath);
}
