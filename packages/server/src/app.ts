import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { AgentManager } from "./agent-manager.js";
import { AgentDefinitionSchema, type Config, type AgentDefinition } from "@openacme/config";
import { listProviders, MODEL_PRESETS } from "@openacme/llm-provider";
import { readAuthFile } from "@openacme/auth";
import { registry as toolRegistry } from "@openacme/tools";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create the Hono HTTP app with all API routes.
 */
export async function createApp(config: Config): Promise<{ app: Hono; manager: AgentManager }> {
  const app = new Hono();
  const manager = new AgentManager(config);

  // Middleware
  app.use("/*", cors());

  // Health check
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      version: "0.0.1",
      agents: manager.listAgents().length,
      skills: manager.skillRegistry.size,
    })
  );

  // ── Agents ──
  app.get("/api/agents", (c) => {
    const agents = manager.listAgents();
    return c.json(agents);
  });

  app.get("/api/agents/:id", (c) => {
    try {
      const agent = manager.getAgent(c.req.param("id"));
      return c.json(agent.config);
    } catch {
      return c.json({ error: "Agent not found" }, 404);
    }
  });

  app.post("/api/agents", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Add default id if not provided
    const id = (body.id as string) || randomUUID();

    // Validate and apply defaults using Zod schema
    const parseResult = AgentDefinitionSchema.safeParse({ ...body, id });
    if (!parseResult.success) {
      const errors = parseResult.error.errors.map(e => `${e.path.join(".")}: ${e.message}`);
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const def = parseResult.data;
    manager.createAgent(def);
    return c.json(def, 201);
  });

  app.put("/api/agents/:id", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    try {
      const updated = manager.updateAgent(c.req.param("id"), body);
      return c.json(updated);
    } catch (e) {
      const message = (e as Error).message;
      // Distinguish between not found and other errors
      if (message.includes("not found")) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 400);
    }
  });

  app.delete("/api/agents/:id", (c) => {
    const id = c.req.param("id");
    try {
      // Check if agent exists first
      manager.getAgent(id);
      manager.deleteAgent(id);
      return c.json({ success: true });
    } catch {
      return c.json({ error: "Agent not found" }, 404);
    }
  });

  // ── Sessions ──
  app.get("/api/agents/:id/sessions", (c) => {
    const sessions = manager.sessionStore.list(c.req.param("id"));
    return c.json(sessions);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    const messages = manager.messageStore.getHistory(c.req.param("id"));
    return c.json(messages);
  });

  app.delete("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = manager.sessionStore.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    // messages cascade-delete via FK; FTS triggers keep the index in sync
    manager.sessionStore.delete(id);
    return c.json({ success: true });
  });

  // ── Chat (SSE streaming) ──
  app.post("/api/chat", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { agentId, sessionId, message } = body as {
      agentId: string;
      sessionId?: string;
      message: string;
    };

    if (!agentId || !message) {
      return c.json({ error: "agentId and message are required" }, 400);
    }

    const effectiveSessionId = sessionId || randomUUID();

    return streamSSE(c, async (stream) => {
      try {
        // Emit the resolved session id first so the client can pin it across turns
        // (when called without a sessionId, the server creates one — without this
        // chunk the client would create a fresh session on every send).
        await stream.writeSSE({
          event: "session",
          data: JSON.stringify({ type: "session", sessionId: effectiveSessionId }),
        });

        for await (const chunk of manager.chat(
          agentId,
          effectiveSessionId,
          message
        )) {
          await stream.writeSSE({
            event: chunk.type,
            data: JSON.stringify(chunk),
          });
        }
      } catch (error) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          }),
        });
      }
    });
  });

  // ── Models ──
  // Returns each provider augmented with its curated model presets so the
  // UI can render a model dropdown without a second round-trip.
  app.get("/api/models", (c) => {
    return c.json(
      listProviders().map((p) => ({
        ...p,
        models: MODEL_PRESETS[p.id] ?? [],
      }))
    );
  });

  // ── Tools ──
  app.get("/api/tools", (c) => {
    return c.json({
      tools: toolRegistry.getInfo(),
      toolsets: toolRegistry.getToolsets(),
    });
  });

  // ── Skills ──
  app.get("/api/skills", (c) => {
    return c.json(manager.skillRegistry.getIndex());
  });

  app.get("/api/skills/:name", (c) => {
    const skill = manager.skillRegistry.getSkill(c.req.param("name"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json(skill);
  });

  app.post("/api/skills", async (c) => {
    let body: { name: string; description: string; tags: string[]; body: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { name, description, tags, body: skillBody } = body;
    if (!name || !description) {
      return c.json({ error: "name and description are required" }, 400);
    }

    try {
      const skillsDir = path.resolve(config.dataDir, config.skills.directory);
      const skill = manager.skillRegistry.saveSkill(
        skillsDir,
        name,
        description,
        tags || [],
        skillBody || ""
      );
      return c.json(skill, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.delete("/api/skills/:name", (c) => {
    const name = c.req.param("name");
    const skillsDir = path.resolve(config.dataDir, config.skills.directory);
    const deleted = manager.skillRegistry.deleteSkill(skillsDir, name);
    if (!deleted) {
      return c.json({ error: "Skill not found" }, 404);
    }
    return c.json({ success: true });
  });

  // ── Config ──
  app.get("/api/config", (c) => {
    // Return safe subset (no API keys)
    return c.json({
      dataDir: config.dataDir,
      model: {
        provider: config.model.provider,
        model: config.model.model,
      },
      server: config.server,
      behavior: config.behavior,
      skills: config.skills,
    });
  });

  // ── API Keys ──
  const envPath = path.join(config.dataDir, ".env");

  // Get which API keys are configured (not the actual values).
  // A provider is "configured" if either an API key is present (.env or
  // process.env) OR there is an OAuth entry in auth.json (subscription auth).
  app.get("/api/keys", (c) => {
    const providers = listProviders();
    const configured: Record<string, boolean> = {};
    const sources: Record<string, "api_key" | "oauth"> = {};

    let envVars: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      envVars = dotenv.parse(envContent);
    }

    const authFile = readAuthFile(config.dataDir);

    for (const provider of providers) {
      const hasApiKey =
        !!provider.envVar &&
        (!!process.env[provider.envVar] || !!envVars[provider.envVar]);

      const hasOAuth =
        (provider.id === "openai" || provider.id === "anthropic") &&
        !!authFile[provider.id]?.access_token;

      configured[provider.id] = hasApiKey || hasOAuth;
      // Prefer api_key source if both are present (matches registry resolution
      // when config.auth is unset/api_key).
      if (hasApiKey) sources[provider.id] = "api_key";
      else if (hasOAuth) sources[provider.id] = "oauth";
    }

    return c.json({ configured, sources, envPath });
  });

  // Save an API key to the .env file
  app.post("/api/keys", async (c) => {
    let body: { provider: string; apiKey: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { provider, apiKey } = body;
    if (!provider || !apiKey) {
      return c.json({ error: "provider and apiKey are required" }, 400);
    }

    // Find the provider's env var name
    const providers = listProviders();
    const providerInfo = providers.find((p) => p.id === provider);
    if (!providerInfo?.envVar) {
      return c.json({ error: "Unknown provider or no env var defined" }, 400);
    }

    // Ensure data directory exists
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }

    // Read existing .env using dotenv.parse
    let envVars: Record<string, string> = {};
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, "utf-8");
      envVars = dotenv.parse(envContent);
    }

    // Update the key
    const envVar = providerInfo.envVar;
    envVars[envVar] = apiKey.trim();

    // Write back as key=value lines
    const newContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n";

    fs.writeFileSync(envPath, newContent);

    // Also set in current process so it takes effect immediately
    process.env[envVar] = apiKey.trim();

    return c.json({ success: true, envVar });
  });

  // ── Static Web UI (if bundled) ──
  const webDir = path.resolve(__dirname, "../web");
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    const { serveStatic } = await import("@hono/node-server/serve-static");

    // Serve static assets (_next, favicon, etc.)
    app.use("/*", serveStatic({ root: webDir }));

    // Handle Next.js static export routes (e.g., /settings -> settings.html)
    app.get("*", (c) => {
      const urlPath = c.req.path;

      // Try to find the corresponding .html file for the route
      const htmlFile = urlPath === "/"
        ? path.join(webDir, "index.html")
        : path.join(webDir, `${urlPath.slice(1)}.html`);

      if (fs.existsSync(htmlFile)) {
        return c.html(fs.readFileSync(htmlFile, "utf-8"));
      }

      // Fallback to index.html for SPA routing
      return c.html(fs.readFileSync(path.join(webDir, "index.html"), "utf-8"));
    });
  }

  return { app, manager };
}
