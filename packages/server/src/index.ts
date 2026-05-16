import "@openacme/config/telemetry-bootstrap";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, getRequestListener } from "@hono/node-server";
import {
  loadConfig,
  readLastVersion,
  writeLastVersion,
} from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import { createApp } from "./app.js";
import { createDevHttpServer } from "./dev-proxy.js";

const log = createLogger("server.index");

/**
 * Resolve the running platform version from `@openacme/server`'s own
 * `package.json`. Published packages are version-locked via Changesets,
 * so the server's version is canonical for "what's installed."
 *
 * Dev (`pnpm dev` → tsx): src/index.ts → ../package.json.
 * Published: dist/index.js → ../package.json.
 */
function readPlatformVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  return pkg.version;
}

/**
 * Start the OpenAcme agent server.
 */
export async function startServer(dataDirOverride?: string) {
  const config = loadConfig(dataDirOverride);
  // Make the resolved data dir discoverable by the LLM provider's OAuth path
  // without invasive signature changes.
  if (!process.env["OPENACME_DATA_DIR"]) {
    process.env["OPENACME_DATA_DIR"] = config.dataDir;
  }
  const { app, manager } = await createApp(config);

  // Initialize MCP connections for all agents
  await manager.initMCP();

  // Materialize platform-managed catalog templates (today: Acme) that
  // aren't on disk yet. Per-template idempotent. Runs AFTER initMCP —
  // the import path calls reinitMCPForAgent itself for new agents.
  await manager.ensureManagedAgents();

  // Post-update refresh: when the installed platform version differs
  // from the recorded marker, refresh in-place every managed agent and
  // every bundled (`source: builtin`) skill so the local copy tracks
  // the new bundled definitions. Best-effort — each step is failure-
  // tolerant and the marker is bumped either way so we don't retry on
  // every boot and spam logs.
  //
  // First-ever boot (no marker) skips the refresh — ensureManagedAgents
  // above just installed everything fresh, and there are no builtin
  // skills installed yet for refreshBundledSkills to operate on. Just
  // stamp the marker so the next boot is cheap.
  const installedVersion = readPlatformVersion();
  const lastVersion = readLastVersion(config.dataDir);
  if (lastVersion === undefined) {
    tryWriteMarker(config.dataDir, installedVersion);
  } else if (lastVersion !== installedVersion) {
    log.info(
      { from: lastVersion, to: installedVersion },
      "platform version changed — refreshing bundled artifacts"
    );
    await tryStep("refreshManagedAgents", () => manager.refreshManagedAgents());
    await tryStep("refreshBundledSkills", () => manager.refreshBundledSkills());
    tryWriteMarker(config.dataDir, installedVersion);
  }

  // Start the periodic dispatcher. Runs the startup sweep (resets
  // stale in_progress from any prior crash) and schedules the 60s
  // tick. Replaces the old event-driven `TaskScheduler`.
  await manager.dispatcher.start();

  const port = config.server.port;
  const host = config.server.host;
  const proxyTargetEnv = process.env["OPENACME_DEV_PROXY_TARGET"];

  console.log(`\n🚀 OpenAcme Agent Server`);
  console.log(`   http://${host}:${port}`);
  console.log(`   Agents: ${manager.listAgents().length}`);
  console.log(`   Health: http://${host}:${port}/api/health`);
  if (proxyTargetEnv) console.log(`   Dev: non-API → ${proxyTargetEnv}`);
  console.log("");

  let server: ReturnType<typeof serve>;
  if (proxyTargetEnv) {
    const httpServer = createDevHttpServer({
      honoListener: getRequestListener(app.fetch),
      proxyTarget: new URL(proxyTargetEnv),
    });
    httpServer.listen(port, host);
    server = httpServer as unknown as ReturnType<typeof serve>;
  } else {
    server = serve({
      fetch: app.fetch,
      port,
      hostname: host,
    });
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n🛑 Shutting down...");
    manager.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

async function tryStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn({ err }, `${name} failed during post-update`);
  }
}

function tryWriteMarker(dataDir: string, version: string): void {
  try {
    writeLastVersion(dataDir, version);
  } catch (err) {
    log.warn({ err }, "failed to write .last-cli-version marker");
  }
}

export { createApp } from "./app.js";
export { AgentManager } from "./agent-manager.js";
export {
  buildHomePayload,
  type HomePayload,
  type SessionSummary,
} from "./routes/home.js";
export {
  SessionBroadcaster,
  type BroadcastEnvelope,
  type SessionBroadcastEvent,
  type WorkforceListener,
} from "./broadcaster.js";

// If run directly: start the server
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/server/dist/index.js");

if (isDirectRun) {
  startServer().catch((err) => log.error({ err }, "server boot failed"));
}
