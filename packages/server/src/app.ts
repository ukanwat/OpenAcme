import { Hono } from "hono";
import { cors } from "hono/cors";
import * as crypto from "node:crypto";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import {
  ensureStepBoundaries,
  finalizeOrphanToolParts,
  sanitizeStoredHistory,
  type OpenAcmeUIMessage,
} from "@openacme/agent-core";
import { AgentManager } from "./agent-manager.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerUploadsRoutes, type UploadsContext } from "./routes/uploads.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerSkillsHubRoutes } from "./routes/skills-hub.js";
import { registerAgentResourceRoutes } from "./routes/agent-resources.js";
import { registerAgentCatalogRoutes } from "./routes/agent-catalog.js";
import { SkillHub, HubError } from "@openacme/skills";
import {
  AgentDefinitionSchema,
  MCPServerConfigSchema,
  loadGlobalMcpServers,
  saveGlobalMcpServers,
  readSecret,
  lookupModelMetadata,
  type Config,
  type AgentDefinition,
  type MCPServerConfig,
} from "@openacme/config";
import {
  listProviders,
  MODEL_PRESETS,
  detectProviderCredentials,
} from "@openacme/llm-provider";
import { registry as toolRegistry, closeShellSession } from "@openacme/tools";
import { MCPClient } from "@openacme/mcp-client";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const PENDING_URL_RE = /^\/api\/attachments\/__pending__\/(pend_[^/]+)\/(.+)$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Create the Hono HTTP app with all API routes.
 */
export async function createApp(config: Config): Promise<{ app: Hono; manager: AgentManager }> {
  const app = new Hono();
  const manager = new AgentManager(config);

  // Middleware
  app.use("/*", cors());

  // Auth: load the secret once at boot so we can timing-safe-compare hashes
  // on each request. Loopback Host always bypasses; the secret only matters
  // when the daemon is bound non-loopback (or behind a tunnel).
  const rawSecret = readSecret(config.dataDir);
  const secretSha256 = rawSecret
    ? crypto.createHash("sha256").update(rawSecret).digest("hex")
    : null;

  // Auth routes must be reachable without a cookie — mount BEFORE the
  // gate. The middleware also whitelists /api/auth/* and /login, but
  // mounting first is the belt to that suspenders.
  registerAuthRoutes(app, { secretSha256 });
  registerSetupRoutes(app, { dataDir: config.dataDir });
  app.use("/*", authMiddleware({ secretSha256 }));

  // Attachment upload + serve routes. The orphan map returned here is
  // shared with /api/chat below so we can resolve `attachmentId` parts
  // back to a path on disk.
  const uploads: UploadsContext = registerUploadsRoutes(app, manager);

  // Tasks: founder read/edit/delete. POST is intentionally absent — task
  // creation is agent-only via the `task_create` tool.
  registerTaskRoutes(app, manager);

  // Per-agent resource files under `<agentDir>/resources/`. Mounted
  // before the generic /api/agents/:id routes since the path-collisions
  // (`:id/resources` vs `:id`) are disambiguated by the segment.
  registerAgentResourceRoutes(app, manager);

  // Bundled agent catalog — browse + import templates. Mount before the
  // generic /api/agents/:id so /api/agents/catalog/* takes the specific path.
  registerAgentCatalogRoutes(app, manager, config);

  // Health check
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      version: PKG_VERSION,
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
    // Return the full AgentDefinition (matches what GET /api/agents
    // lists), not the runtime AgentConfig — the latter drops
    // persisted-only fields like `role` that the web UI needs.
    const def = manager.getAgentDef(c.req.param("id"));
    if (!def) return c.json({ error: "Agent not found" }, 404);
    return c.json(def);
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
      const errors = parseResult.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join(".")}: ${e.message}`);
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    const def = parseResult.data;
    try {
      await manager.createAgent(def);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
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
      const updated = await manager.updateAgent(c.req.param("id"), body);
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

  app.delete("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    try {
      // Check if agent exists first
      manager.getAgent(id);
      await manager.deleteAgent(id);
      return c.json({ success: true });
    } catch {
      return c.json({ error: "Agent not found" }, 404);
    }
  });

  // ── Sessions ──
  // listActive (not list) hides sessions that have been compressed away —
  // parents that have a child session pointing at them. Otherwise the sidebar
  // shows the same conversation twice (parent + child) after a compression
  // fork.
  app.get("/api/agents/:id/sessions", (c) => {
    const sessions = manager.sessionStore.listActive(c.req.param("id"));
    return c.json(sessions);
  });

  app.get("/api/sessions/:id/messages", (c) => {
    // Returns UIMessage[] verbatim — useChat consumes these directly via
    // setMessages on session change.
    const messages = sanitizeStoredHistory(
      manager.messageStore.getHistory(c.req.param("id"))
    );
    return c.json(messages);
  });

  app.delete("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = manager.sessionStore.get(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    // Tasks bound to this session would otherwise become zombies — the
    // scheduler can't allocate a fresh session for an already-bound task
    // and silently drops events for the missing session. Null out
    // bindings; reset in_progress tasks to open so they can be re-picked.
    const orphaned = manager.taskStore.list({ session_id: id });
    for (const t of orphaned) {
      if (t.status === "done" || t.status === "canceled") continue;
      const patch: { session_id: null; status?: "open" } = { session_id: null };
      if (t.status === "in_progress") patch.status = "open";
      try {
        await manager.taskStore.update(t.id, patch, { actor: "system:user" });
      } catch (e) {
        console.warn(
          `Failed to clear task ${t.id} binding on session ${id} delete: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    // messages cascade-delete via FK; FTS triggers keep the index in sync
    manager.sessionStore.delete(id);
    // Reap the per-session bash subprocess if one was running.
    closeShellSession(session.agentId, id);
    return c.json({ success: true });
  });

  // ── Chat (UIMessage stream) ──
  // SDK protocol — we wrap streamText inside createUIMessageStream so we
  // can emit a custom `data-session` part for session-id pinning before
  // the model starts producing tokens. The web client reads this part
  // via useChat's onData. The handler does not persist incrementally;
  // onFinish writes the new user UIMessage + the assembled response.
  app.post("/api/chat", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { agentId, sessionId, messages } = body as {
      agentId: string;
      sessionId?: string;
      messages: unknown;
    };

    if (!agentId || !Array.isArray(messages)) {
      return c.json(
        { error: "agentId and messages[] are required" },
        400
      );
    }

    const def = manager.getAgentDef(agentId);
    if (!def) return c.json({ error: "Agent not found" }, 404);

    const effectiveSessionId = sessionId || randomUUID();

    // Validate-then-commit: walk the incoming messages once to collect
    // every pending id; verify they're all known; only then commit (move
    // files under the session dir). Naive map-and-commit has a partial-
    // failure footgun — earlier files would be moved before a later
    // unknown id triggers the 400, leaving orphan files in the session
    // dir with no message row to reference them.
    const incoming = messages as UIMessage[];
    const pendingIds: string[] = [];
    for (const m of incoming) {
      if (m.role !== "user") continue;
      for (const p of m.parts) {
        const tp = p as { type?: string; url?: string };
        if (tp.type !== "file" || typeof tp.url !== "string") continue;
        const match = tp.url.match(PENDING_URL_RE);
        if (!match) continue;
        const pendingId = match[1]!;
        if (!uploads.pending.has(pendingId)) {
          return c.json(
            { error: `Unknown or expired attachment: ${pendingId}` },
            400
          );
        }
        pendingIds.push(pendingId);
      }
    }

    // All pending ids are known — safe to commit. Cache results so
    // each id only commits once even if referenced by multiple parts
    // (defensive — useChat won't normally do that, but the user could
    // hand-craft a request).
    const committedById = new Map<
      string,
      ReturnType<typeof uploads.commit>
    >();
    const attachmentKinds: Array<"image" | "file"> = [];
    const committed = incoming.map((m) => {
      if (m.role !== "user") return m;
      const parts = m.parts.map((p) => {
        const tp = p as { type?: string; url?: string };
        if (tp.type !== "file" || typeof tp.url !== "string") return p;
        const match = tp.url.match(PENDING_URL_RE);
        if (!match) return p;
        const pendingId = match[1]!;
        let result = committedById.get(pendingId);
        if (result === undefined) {
          result = uploads.commit(pendingId, effectiveSessionId);
          committedById.set(pendingId, result);
        }
        if (!result) return p;
        attachmentKinds.push(result.kind);
        return {
          ...(p as object),
          url: result.url,
          mediaType: result.mediaType,
          filename: result.filename,
        } as typeof p;
      });
      return { ...m, parts };
    });

    // Provider gating: reject file/image parts on text-only models. The
    // bundled registry's `inputModalities` is the source of truth; an
    // empty/missing list means "unknown" and we let the request through.
    if (attachmentKinds.length > 0) {
      const meta = lookupModelMetadata(def.model);
      if (meta.inputModalities && meta.inputModalities.length > 0) {
        const allowed = new Set(meta.inputModalities);
        const hasImg = attachmentKinds.includes("image");
        const hasFile = attachmentKinds.includes("file");
        if (hasImg && !allowed.has("image")) {
          return c.json(
            {
              error: `Model '${def.model.model}' does not accept images`,
              supportedModalities: meta.inputModalities,
            },
            400
          );
        }
        if (
          hasFile &&
          !allowed.has("pdf") &&
          !allowed.has("file")
        ) {
          return c.json(
            {
              error: `Model '${def.model.model}' does not accept PDFs/files`,
              supportedModalities: meta.inputModalities,
            },
            400
          );
        }
      }
    }

    // Ensure the session row exists with the caller-supplied id BEFORE
    // we write the user message inside onFinish.
    if (!manager.sessionStore.get(effectiveSessionId)) {
      manager.sessionStore.create(agentId, { id: effectiveSessionId });
    }

    const signal = c.req.raw.signal;

    const stream = createUIMessageStream<OpenAcmeUIMessage>({
      execute: async ({ writer }) => {
        // Surface the resolved sessionId for the client. `transient: true`
        // keeps it out of the persisted parts (only useChat's onData fires).
        writer.write({
          type: "data-session",
          data: { sessionId: effectiveSessionId },
          transient: true,
        });
        // Block autonomous wakes for the duration of this interactive
        // turn. Cleared in the finally below; onFinish clears too
        // (idempotent) for the writer.merge success path.
        manager.taskScheduler.markInteractiveBusy(effectiveSessionId);
        try {
          const agent = manager.getAgent(agentId);

          const recall = await agent.applyMemoryRecall({
            history: committed,
            signal,
          });
          // Attach to the new user msg before runStream: the model sees
          // it via uiToModelMessages this turn; persisted in onFinish so
          // future loads replay identical bytes (prefix cache).
          const recallPart = agent.buildRelevantMemoryPart(
            recall.entries,
            recall.modelContent
          );
          if (recallPart) {
            const lastUser = committed[committed.length - 1];
            if (lastUser?.role === "user") {
              lastUser.parts = [
                ...(lastUser.parts as UIMessage["parts"]),
                recallPart as unknown as UIMessage["parts"][number],
              ];
            }
          }

          const result = await agent.runStream({
            sessionId: effectiveSessionId,
            history: committed,
            signal,
          });
          writer.merge(result.toUIMessageStream({ sendStart: false }));
        } catch (e) {
          manager.taskScheduler.clearInteractiveBusy(effectiveSessionId);
          throw e;
        }
      },
      originalMessages: committed as unknown as OpenAcmeUIMessage[],
      generateId: () => randomUUID(),
      onFinish: ({ responseMessage }) => {
        // Lift the interactive-busy gate before persistence so any wakes
        // queued during the turn fire promptly. Idempotent.
        manager.taskScheduler.clearInteractiveBusy(effectiveSessionId);
        // Persist the new user message (last item in committed) + the
        // assembled assistant response. Prior history was already in
        // the DB and was just sent back to us by useChat.
        try {
          const lastUser = committed[committed.length - 1];
          if (lastUser?.role === "user") {
            manager.messageStore.append(effectiveSessionId, {
              id: lastUser.id,
              role: "user",
              parts: lastUser.parts as unknown[],
            });
          }
          const sanitizedParts = ensureStepBoundaries(
            finalizeOrphanToolParts(
              responseMessage.parts as UIMessage["parts"]
            )
          );
          manager.messageStore.append(effectiveSessionId, {
            id: responseMessage.id,
            role: responseMessage.role as "user" | "assistant",
            parts: sanitizedParts as unknown[],
          });

          // Title from the assistant's first text-part if the session
          // doesn't have one yet.
          const session = manager.sessionStore.get(effectiveSessionId);
          if (session && !session.title) {
            const text = responseMessage.parts
              .filter(
                (p): p is { type: "text"; text: string } =>
                  (p as { type?: unknown }).type === "text"
              )
              .map((p) => p.text)
              .join(" ")
              .slice(0, 80)
              .replace(/\n/g, " ");
            if (text) manager.sessionStore.updateTitle(effectiveSessionId, text);
          }
          manager.sessionStore.touch(effectiveSessionId);
        } catch (e) {
          console.error(
            `Failed to persist chat turn: ${
              e instanceof Error ? e.message : String(e)
            }`
          );
        }

        // Phase-3 extractor — fire-and-forget. Agent owns the cursor +
        // in-progress guard so re-entrant fires (multiple turns
        // arriving fast) coalesce into one fork. Skip-paths inside the
        // extractor cover main-agent-already-wrote / no-new-content.
        try {
          const agent = manager.getAgent(agentId);
          const turnHistory = [
            ...committed,
            responseMessage as unknown as UIMessage,
          ];
          agent.fireExtractor({
            sessionId: effectiveSessionId,
            sessionMessages: turnHistory,
          });
        } catch (e) {
          console.warn(
            `[memory.extractor] launch failed for agent=${agentId}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  });

  // ── Models ──
  // Returns each provider augmented with its curated model presets so the
  // UI can render a model dropdown without a second round-trip. Each preset
  // is also enriched with `inputModalities` from the bundled registry so
  // the client can disable the file picker on text-only models.
  app.get("/api/models", (c) => {
    return c.json(
      listProviders().map((p) => ({
        ...p,
        models: (MODEL_PRESETS[p.id] ?? []).map((m) => {
          const meta = lookupModelMetadata({
            provider: p.id,
            model: m.id,
            auth: "api_key",
          });
          return {
            ...m,
            inputModalities: meta.inputModalities,
          };
        }),
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

  // ── MCP ──

  // Status of every agent's MCP servers — connected, failed, disabled,
  // awaiting_oauth — used by the UI to render the status panel.
  app.get("/api/mcp/status", (c) => {
    return c.json({ agents: manager.getMcpStatus() });
  });

  app.get("/api/agents/:id/mcp/status", (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    const servers = manager.getMcpClient(id)?.getStatus() ?? [];
    return c.json({ agentId: id, servers });
  });

  // Force a full reinit of one agent's MCP — disconnect + reconnect every
  // server. Use after a global mcp.json edit when the watcher missed it
  // (e.g., on a network filesystem) or to recover from a transient failure.
  app.post("/api/agents/:id/mcp/refresh", async (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    await manager.reinitMCPForAgent(id);
    const servers = manager.getMcpClient(id)?.getStatus() ?? [];
    return c.json({ agentId: id, servers });
  });

  // Per-server connect/disconnect/reconnect for an agent.
  app.post("/api/agents/:id/mcp/servers/:name/connect", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    return c.json(await client.connectServer(c.req.param("name")));
  });

  app.post("/api/agents/:id/mcp/servers/:name/disconnect", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    await client.disconnectServer(c.req.param("name"));
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/mcp/servers/:name/reconnect", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    return c.json(await client.reconnect(c.req.param("name")));
  });

  // Force a fresh OAuth flow — clears stored tokens for that server,
  // then reconnects. Use when a token's been revoked server-side or
  // when the user wants to switch accounts.
  app.post("/api/agents/:id/mcp/servers/:name/reauth", async (c) => {
    const client = manager.getMcpClient(c.req.param("id"));
    if (!client) return c.json({ error: "Agent has no MCP client" }, 404);
    const name = c.req.param("name");
    await manager.clearMcpOAuthTokens(name);
    return c.json(await client.reconnect(name));
  });

  // Dry-run a config without registering any tools — for the "Test
  // connection" UI button. Body is a single MCPServerConfig.
  app.post("/api/mcp/test", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = MCPServerConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: "Validation failed",
          details: parsed.error.issues.map(
            (err: { path: PropertyKey[]; message: string }) =>
              `${err.path.join(".")}: ${err.message}`
          ),
        },
        400
      );
    }
    // `testConnection` opens a transport, lists tools, closes — never
    // touches the registry or the manager's per-agent maps. Use a
    // throwaway client so we don't disturb any live agent state.
    const probe = new MCPClient(toolRegistry);
    const result = await probe.testConnection(parsed.data);
    return c.json(result);
  });

  // ── Global MCP catalog (~/.openacme/mcp.json) ──

  app.get("/api/mcp/global", (c) => {
    return c.json({ mcpServers: loadGlobalMcpServers(config.dataDir) });
  });

  // PUT replaces the whole catalog. Triggers reinit for every agent so
  // the new/changed/removed servers take effect without a process restart.
  app.put("/api/mcp/global", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = (raw && typeof raw === "object" ? raw : {}) as {
      mcpServers?: unknown;
    };
    if (
      body.mcpServers !== undefined &&
      (typeof body.mcpServers !== "object" || body.mcpServers === null)
    ) {
      return c.json({ error: "mcpServers must be an object" }, 400);
    }
    const entries = Object.entries(
      (body.mcpServers ?? {}) as Record<string, unknown>
    );
    const validated: Record<string, MCPServerConfig> = {};
    for (const [name, cfg] of entries) {
      const result = MCPServerConfigSchema.safeParse(cfg);
      if (!result.success) {
        return c.json(
          {
            error: `Invalid config for server '${name}'`,
            details: result.error.issues.map(
              (err: { path: PropertyKey[]; message: string }) =>
                `${err.path.join(".")}: ${err.message}`
            ),
          },
          400
        );
      }
      validated[name] = result.data;
    }
    saveGlobalMcpServers(config.dataDir, validated);
    for (const def of manager.listAgents()) {
      await manager.reinitMCPForAgent(def.id);
    }
    return c.json({ mcpServers: validated });
  });

  // Per-agent private servers. The agent-store rejects writes whose names
  // collide with the global catalog.
  app.post("/api/agents/:id/mcp/servers", async (c) => {
    const id = c.req.param("id");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const body = (raw && typeof raw === "object" ? raw : {}) as {
      name?: unknown;
      config?: unknown;
    };
    if (typeof body.name !== "string" || body.name.length === 0) {
      return c.json({ error: "'name' must be a non-empty string" }, 400);
    }
    const cfgResult = MCPServerConfigSchema.safeParse(body.config);
    if (!cfgResult.success) {
      return c.json(
        {
          error: "Invalid server config",
          details: cfgResult.error.issues.map(
            (err: { path: PropertyKey[]; message: string }) =>
              `${err.path.join(".")}: ${err.message}`
          ),
        },
        400
      );
    }
    const next: Record<string, MCPServerConfig> = {
      ...(def.mcpServers ?? {}),
      [body.name]: cfgResult.data,
    };
    try {
      await manager.updateAgent(id, { mcpServers: next });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ id, mcpServers: next });
  });

  app.delete("/api/agents/:id/mcp/servers/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const def = manager.agentStore.get(id);
    if (!def) return c.json({ error: "Agent not found" }, 404);
    if (!Object.prototype.hasOwnProperty.call(def.mcpServers ?? {}, name)) {
      return c.json({ error: "Server not found in agent" }, 404);
    }
    const next: Record<string, MCPServerConfig> = { ...def.mcpServers };
    delete next[name];
    await manager.updateAgent(id, { mcpServers: next });
    return c.json({ id, mcpServers: next });
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
    // If this skill was hub-managed, drop the lockfile entry too so we
    // don't leave a zombie behind (lock claims installed, disk doesn't).
    // uninstall() is a no-op if not in the lockfile.
    try {
      new SkillHub(skillsDir, manager.skillRegistry).uninstall(name);
    } catch {
      // best-effort cleanup; legacy delete already succeeded
    }
    return c.json({ success: true });
  });

  // Import a skill folder. Client sends multipart/form-data where each field
  // name is the file's path relative to the skill root. Top-level
  // `SKILL.md` required. Caps and validation happen inside the hub.
  app.post("/api/skills/import", async (c) => {
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "Expected multipart/form-data" }, 400);
    }

    const entries: { relPath: string; file: File }[] = [];
    for (const [rawKey, raw] of Object.entries(form)) {
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) {
        if (value instanceof File) entries.push({ relPath: rawKey, file: value });
      }
    }
    if (entries.length === 0) {
      return c.json({ error: "No files in upload" }, 400);
    }

    // Strip a single shared top-level folder if every entry has one — lets
    // users drop either `my-skill/SKILL.md` or `SKILL.md` and get the same
    // result. Detailed path validation runs inside the hub.
    let topPrefix: string | null = null;
    for (const e of entries) {
      const parts = e.relPath.replace(/\\/g, "/").split("/");
      const head = parts[0] ?? "";
      if (parts.length > 1 && head) {
        if (topPrefix === null) topPrefix = head;
        else if (topPrefix !== head) topPrefix = "";
      } else {
        topPrefix = "";
      }
    }
    const stripPrefix = topPrefix ? topPrefix + "/" : "";

    const skillsDir = path.resolve(config.dataDir, config.skills.directory);
    const staging = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openacme-import-")
    );

    try {
      for (const e of entries) {
        const rel = e.relPath.replace(/\\/g, "/");
        const trimmed = stripPrefix && rel.startsWith(stripPrefix)
          ? rel.slice(stripPrefix.length)
          : rel;
        if (!trimmed) continue;
        const target = path.join(staging, trimmed);
        const targetReal = path.resolve(target);
        if (!targetReal.startsWith(path.resolve(staging) + path.sep)) {
          return c.json({ error: `Invalid path: ${e.relPath}` }, 400);
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const buf = Buffer.from(await e.file.arrayBuffer());
        await fs.promises.writeFile(target, buf);
      }

      const hub = new SkillHub(skillsDir, manager.skillRegistry);
      try {
        const result = await hub.install(staging, { source: "local" });
        const skill = manager.skillRegistry.getSkill(result.name);
        return c.json({ success: true, name: result.name, skill }, 201);
      } catch (err) {
        if (err instanceof HubError) {
          const code = err.code === "ALREADY_INSTALLED" || err.code === "LOCAL_SKILL_EXISTS"
            ? 409
            : 400;
          return c.json({ error: err.message }, code);
        }
        return c.json(
          { error: err instanceof Error ? err.message : String(err) },
          500
        );
      }
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  });

  // ── Skills Hub (multi-source import) ──
  registerSkillsHubRoutes(app, manager, config);

  // ── AGENTS.md ──
  app.get("/api/agents-md", (c) => {
    return c.json({ content: manager.getAgentsMd() ?? null });
  });

  app.put("/api/agents-md", async (c) => {
    let body: { content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.content !== "string") {
      return c.json({ error: "Body must be { content: string }" }, 400);
    }
    try {
      manager.setAgentsMd(body.content);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500
      );
    }
    return c.json({ content: manager.getAgentsMd() ?? null });
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

  app.get("/api/keys", (c) => c.json(detectProviderCredentials(config.dataDir)));

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

  // ── Static Web UI ──
  // Skipped entirely under the dev proxy — the proxy handles non-API. Otherwise
  // prefer the bundled path (published install, filled by prepack) and fall
  // back to the workspace export (e.g. test daemons after `pnpm build`).
  const inDevProxy = !!process.env["OPENACME_DEV_PROXY_TARGET"];
  const bundledWebDir = path.resolve(__dirname, "../web");
  const workspaceWebDir = path.resolve(__dirname, "../../../apps/web/out");
  const webDir = !inDevProxy && fs.existsSync(path.join(bundledWebDir, "index.html"))
    ? bundledWebDir
    : !inDevProxy && fs.existsSync(path.join(workspaceWebDir, "index.html"))
      ? workspaceWebDir
      : null;
  if (webDir) {
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
