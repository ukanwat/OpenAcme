import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_URL = "https://registry.npmjs.org/@openacme/cli/latest";
const FETCH_TIMEOUT_MS = 5_000;

/**
 * Best-effort package-manager detection. The bin symlink that
 * `openacme` resolves through usually contains a `/pnpm/`, `/.npm/`,
 * or `/.bun/` segment in its path; the `npm_config_user_agent` env
 * var is a fallback for invocations through `pnpm exec` / `npm exec`.
 */
type PackageManager = "pnpm" | "npm" | "bun" | "unknown";

interface InstallCommand {
  pm: PackageManager;
  command: string;
}

function detectPackageManager(): InstallCommand {
  // 1. Resolve where `openacme` actually lives on disk.
  let resolved = "";
  try {
    const bin = process.argv[1];
    if (bin) resolved = realpathSync(bin);
  } catch {
    // ignore — fall through to env-var fallback
  }

  if (resolved) {
    const haystack = resolved.toLowerCase();
    if (haystack.includes("/pnpm/")) return { pm: "pnpm", command: "pnpm add -g @openacme/cli@latest" };
    if (haystack.includes("/.bun/") || haystack.includes("/bun/install/"))
      return { pm: "bun", command: "bun add -g @openacme/cli@latest" };
    // `.npm/` or a system /usr/local/lib/node_modules/... layout — call it npm.
    if (haystack.includes("/.npm/") || haystack.includes("/node_modules/"))
      return { pm: "npm", command: "npm install -g @openacme/cli@latest" };
  }

  // 2. Fallback: registered-pm env var.
  const ua = process.env["npm_config_user_agent"] ?? "";
  if (ua.startsWith("pnpm")) return { pm: "pnpm", command: "pnpm add -g @openacme/cli@latest" };
  if (ua.startsWith("bun")) return { pm: "bun", command: "bun add -g @openacme/cli@latest" };
  if (ua.startsWith("npm")) return { pm: "npm", command: "npm install -g @openacme/cli@latest" };

  return { pm: "unknown", command: "npm install -g @openacme/cli@latest" };
}

/** Simple semver `>` for `X.Y.Z` strings (no prerelease handling). */
function isNewer(latest: string, current: string): boolean {
  const a = latest.split(".").map((n) => parseInt(n, 10));
  const b = current.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

function readCurrentVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/commands/update.js → ../../package.json
  const pkgPath = resolve(here, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

async function fetchLatestVersion(): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`registry returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { version?: string };
    if (!body.version) throw new Error("registry response missing 'version'");
    return body.version;
  } finally {
    clearTimeout(t);
  }
}

interface UpdateOpts {
  json?: boolean;
}

export async function updateCommand(opts: UpdateOpts): Promise<void> {
  const current = readCurrentVersion();
  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ error: msg, current }));
    } else {
      console.error(`Could not check for updates: ${msg}`);
    }
    process.exit(1);
  }

  const { pm, command } = detectPackageManager();

  if (!isNewer(latest, current)) {
    if (opts.json) {
      console.log(JSON.stringify({ current, latest, upToDate: true, pm, command }));
    } else {
      console.log(`OpenAcme is up to date (v${current}).`);
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ current, latest, upToDate: false, pm, command }));
    return;
  }

  console.log("");
  console.log(`OpenAcme v${latest} is available (you have v${current}).`);
  console.log("");
  if (pm === "unknown") {
    console.log("To update, run the install command for your package manager:");
    console.log("  pnpm add -g @openacme/cli@latest");
    console.log("  npm install -g @openacme/cli@latest");
    console.log("  bun add -g @openacme/cli@latest");
  } else {
    console.log("To update, run:");
    console.log(`  ${command}`);
  }
  console.log("");
  console.log("The platform will refresh bundled agents and skills on the next start.");
}
