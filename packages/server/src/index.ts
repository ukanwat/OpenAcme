import { serve } from "@hono/node-server";
import { loadConfig } from "@openacme/config";
import { createApp } from "./app.js";

/**
 * Start the OpenAcme agent server.
 */
export async function startServer(dataDirOverride?: string) {
  const config = loadConfig(dataDirOverride);
  const { app, manager } = await createApp(config);

  // Initialize MCP connections for all agents
  await manager.initMCP();

  const port = config.server.port;
  const host = config.server.host;

  console.log(`\n🚀 OpenAcme Agent Server`);
  console.log(`   http://${host}:${port}`);
  console.log(`   Agents: ${manager.listAgents().length}`);
  console.log(`   Health: http://${host}:${port}/api/health\n`);

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

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

// If run directly: start the server
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/server/dist/index.js");

if (isDirectRun) {
  startServer().catch(console.error);
}
