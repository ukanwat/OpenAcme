import "@openacme/config/telemetry-bootstrap";
import { serve, getRequestListener } from "@hono/node-server";
import { loadConfig } from "@openacme/config";
import { createLogger } from "@openacme/config/logger";
import { createApp } from "./app.js";
import { createDevHttpServer } from "./dev-proxy.js";

const log = createLogger("server.index");

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

  // Materialize the default Acme agent on a fresh install so the user
  // lands with something to chat with. No-op when any agent already
  // exists. Runs AFTER initMCP — the import path calls
  // reinitMCPForAgent itself for the new agent.
  await manager.ensureDefaultAgents();

  // Start the autonomous task scheduler. Runs the startup sweep
  // (resets stale in_progress) and arms the first wake.
  await manager.taskScheduler.start();

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
