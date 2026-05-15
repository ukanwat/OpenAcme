import { Agent, type AgentConfig } from "@openacme/agent-core";
import {
  createAgentStore,
  loadGlobalMcpServers,
  saveGlobalMcpServers,
  lookupModelMetadata,
  type AgentDefinition,
  type AgentStore,
  type Config,
  type MCPServerConfig,
  type ModelConfig,
} from "@openacme/config";
import {
  createDatabase,
  createSessionStore,
  createMessageStore,
  createCommentStore,
  createEventStore,
  type SessionStore,
  type MessageStore,
  type CommentStore,
  type EventStore,
} from "@openacme/db";
import {
  registry as toolRegistry,
  bindSessionSearch,
  bindSkillView,
  bindMemory,
  bindTaskStore,
  bindBrowser,
  bindAgentTool,
  bindPingUser,
  bindSleep,
  closeAllShellSessions,
  SYSTEM_TOOLS,
} from "@openacme/tools";
import * as fs from "node:fs";
import { MemoryStore } from "@openacme/memory";
import { TaskStore } from "@openacme/tasks";
import { BrowserManager } from "@openacme/browser";
import { TaskScheduler } from "./task-scheduler.js";
import { SessionBroadcaster } from "./broadcaster.js";
import {
  MCPClient,
  FileMCPTokenStore,
  type MCPTokenStore,
  type OAuthCallback,
  type ServerStatus,
} from "@openacme/mcp-client";
import {
  awaitLoopbackCallback,
  openBrowser,
  looksHeadless,
} from "@openacme/auth";
import { HubError, SkillHub, SkillRegistry, type SkillIndexEntry } from "@openacme/skills";
import {
  AgentCatalog,
  buildAgentFromTemplate,
  TemplateImportError,
} from "@openacme/agent-catalog";
import * as path from "node:path";

// Same shape as `SAFE_ID` in `@openacme/memory` and `@openacme/config`'s
// agent-store. Duplicated here to avoid a cross-package import for one
// regex; the three must stay in sync.
const PEER_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Read optional `<dataDir>/AGENTS.md`. Returns undefined when absent. */
function readAgentsMd(dataDir: string): string | undefined {
  const file = path.join(dataDir, "AGENTS.md");
  try {
    const content = fs.readFileSync(file, "utf-8");
    return content.trim().length > 0 ? content : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(
      `Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`
    );
    return undefined;
  }
}

/** Write `<dataDir>/AGENTS.md`, or delete it when `content` is empty/whitespace. */
function writeAgentsMd(dataDir: string, content: string): void {
  const file = path.join(dataDir, "AGENTS.md");
  if (content.trim().length === 0) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return;
  }
  const body = content.endsWith("\n") ? content : content + "\n";
  fs.writeFileSync(file, body, "utf-8");
}

/**
 * AgentManager — manages multiple agent instances, MCP connections, and skills.
 * Routes chat requests to the correct agent.
 */
export class AgentManager {
  private agents = new Map<string, Agent>();
  private db: ReturnType<typeof createDatabase>;
  readonly sessionStore: SessionStore;
  readonly messageStore: MessageStore;
  readonly commentStore: CommentStore;
  readonly eventStore: EventStore;
  readonly attachmentsRoot: string;
  readonly agentsDir: string;
  /** `<dataDir>/AGENTS.md` contents; restart to pick up edits. */
  private agentsMd: string | undefined;
  readonly memoryStore: MemoryStore;
  readonly taskStore: TaskStore;
  readonly taskScheduler: TaskScheduler;
  readonly agentStore: AgentStore;
  readonly browserManager: BrowserManager;
  readonly agentCatalog: AgentCatalog;
  /** In-memory per-session pub/sub for SSE clients. Shared by scheduler,
   *  agent runtime, and the home + per-session stream routes. */
  readonly broadcaster: SessionBroadcaster;
  private config: Config;
  private mcpClients = new Map<string, MCPClient>();
  readonly skillRegistry: SkillRegistry;

  constructor(config: Config) {
    this.config = config;
    this.db = createDatabase(config);
    this.attachmentsRoot = path.join(config.dataDir, "attachments");
    this.sessionStore = createSessionStore(this.db, {
      attachmentsRoot: this.attachmentsRoot,
    });
    this.messageStore = createMessageStore(this.db);
    this.commentStore = createCommentStore(this.db);
    this.eventStore = createEventStore(this.db);

    // Agents live as folders at <dataDir>/agents/<id>/AGENT.md — the
    // directory is the only source of truth, no DB mirror, no shadow
    // state in config.yaml.
    this.agentsDir = path.join(config.dataDir, "agents");
    this.agentStore = createAgentStore(this.agentsDir);
    this.agentsMd = readAgentsMd(config.dataDir);
    // One MemoryStore per AgentManager — shared between every Agent
    // instance and the `memory` tool's binding so the in-process mutex
    // map is consistent across both write paths.
    this.memoryStore = new MemoryStore(this.agentsDir);

    // Wire the FTS5-backed cross-session search into the `session_search`
    // tool. Done here so @openacme/tools doesn't need a runtime dep on
    // @openacme/db. `resolveRoot` lets the tool collapse compression chains
    // back to one root and exclude the current conversation's lineage.
    bindSessionSearch({
      search: (query, limit) => this.messageStore.search(query, limit),
      resolveRoot: (sessionId) => this.sessionStore.getRoot(sessionId),
    });

    // Wire the per-agent MEMORY.md root into the `memory` tool. Same bind
    // pattern as session_search; the tool resolves the active agentId from
    // AsyncLocalStorage at handler call time and uses the store closure to
    // find the file. The index char cap is a platform constant
    // (`DEFAULT_MEMORY_CHAR_LIMIT`) — not per-agent — so the tool reads it
    // directly from `@openacme/memory`.
    bindMemory({
      store: this.memoryStore,
    });

    // Tasks: one shared TaskStore, bound to the task tools and driven
    // by the autonomous scheduler. CommentStore + EventStore wire the
    // store's mutating paths to event emission so the scheduler hears
    // about every state change and the agent's "Recent activity" prompt
    // surface stays current.
    this.taskStore = new TaskStore(path.join(config.dataDir, "tasks"), {
      commentStore: this.commentStore,
      eventStore: this.eventStore,
      validateSession: (id) => this.sessionStore.get(id) !== null,
    });
    bindTaskStore({ store: this.taskStore });

    // ping_user fires a session-anchored event the EventStore listener
    // fans out to (a) the broadcaster for the operator's inbox row and
    // (b) the scheduler's onEvent (no-op for session-only events).
    bindPingUser({
      emit: ({ sessionId, agentId, message }) => {
        this.eventStore.append({
          sessionId,
          agentId,
          kind: "ping_user",
          actor: agentId,
          payload: { message },
        });
      },
    });

    // `sleep` writes the per-session next-probe override. Scheduler
    // arms a cron when this column changes; on probe-fire it's cleared
    // so the next turn either re-sets via sleep or falls back to the
    // agent's default cadence.
    bindSleep({
      setNextCheckAt: (sessionId, unixSeconds) => {
        this.sessionStore.setNextCheckAt(sessionId, unixSeconds);
        // Notify the scheduler so its cron arms reconcile to the new
        // value without waiting for the next event.
        this.taskScheduler.reconcile();
      },
    });

    this.broadcaster = new SessionBroadcaster();
    this.taskScheduler = new TaskScheduler({
      taskStore: this.taskStore,
      sessionStore: this.sessionStore,
      agentManager: this,
      broadcaster: this.broadcaster,
    });
    // Pure event-driven wake — every state change emits an event,
    // scheduler.onEvent runs the unified pipeline (lazy session alloc,
    // echo suppression, debounce + rate-limit queue, fire wake).
    // Same hook also fans the event out to SSE subscribers of the
    // affected session so the operator's home view updates live.
    this.eventStore.onEmit((event) => {
      this.taskScheduler.onEvent(event);
      const sessionId = event.sessionId ?? this.deriveSessionForEvent(event);
      if (sessionId) {
        this.broadcaster.broadcast(sessionId, {
          kind: "task_event",
          event: {
            id: event.id,
            taskId: event.taskId,
            sessionId,
            agentId: event.agentId,
            actor: event.actor ?? null,
            kind: event.kind,
            payload: event.payload,
            createdAt: event.createdAt,
          },
        });
      }
    });
    // setOnChange covers the few mutations that don't emit events
    // (e.g. a bare `start_at` patch with no status change) — it only
    // reconciles cron arms; wakes still go through events.
    this.taskStore.setOnChange(() => this.taskScheduler.reconcile());

    // Browser: one managed Chrome shared across the workforce under
    // `<dataDir>/browser-profile/`. Lazy — Chrome doesn't spawn until
    // the first browser_* tool call. Per-agent tab ownership lives
    // inside the manager. Bound via the same placeholder pattern as
    // session_search so @openacme/tools stays free of a runtime dep
    // on playwright-core.
    this.browserManager = new BrowserManager({
      dataDir: config.dataDir,
      config: config.browser,
    });
    bindBrowser({ manager: this.browserManager });

    // agent_list: surface the workforce directory + the calling agent's peer
    // notes inline so a delegating agent sees canonical role plus their
    // own lived experience in one tool result. Peer notes live at
    // `<agentDir>/memory/peers/<peerId>.md` per memory convention; read
    // directly here (no MemoryStore dep) to keep @openacme/tools free
    // of @openacme/config and @openacme/memory.
    bindAgentTool({
      listAgents: () =>
        this.agentStore.list().map((def) => ({
          id: def.id,
          name: def.name,
          role: def.role ?? "",
        })),
      peerNoteFor: (callerId, peerId) => {
        // Defense in depth — agent ids in the store are SAFE_ID-validated
        // on upsert, but path interpolation is a sharp tool. Reject any
        // id whose shape would let `path.join` escape the peers dir.
        if (!PEER_ID_SAFE.test(callerId) || !PEER_ID_SAFE.test(peerId)) {
          return null;
        }
        const file = path.join(
          this.memoryStore.dirPath(callerId),
          "peers",
          `${peerId}.md`
        );
        try {
          const st = fs.statSync(file);
          const content = fs.readFileSync(file, "utf-8");
          return { content, mtimeMs: st.mtimeMs };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          console.warn(
            `peerNoteFor(${callerId}, ${peerId}) read failed: ${e instanceof Error ? e.message : String(e)}`
          );
          return null;
        }
      },
    });

    // Load skills
    this.skillRegistry = new SkillRegistry();
    const skillsDir = path.isAbsolute(config.skills.directory)
      ? config.skills.directory
      : path.join(config.dataDir, config.skills.directory);
    this.skillRegistry.loadFromDirectory(skillsDir);
    if (this.skillRegistry.size > 0) {
      console.log(`  📚 Loaded ${this.skillRegistry.size} skills`);
    }

    // Wire the skill registry into the `skill_view` tool so agents can
    // pull a skill's body + companion file list on demand. Same bind
    // pattern as session_search to keep @openacme/tools independent of
    // @openacme/skills at runtime.
    bindSkillView({
      lookup: (name) => {
        const s = this.skillRegistry.getSkill(name);
        return s
          ? {
              name: s.name,
              description: s.description,
              tags: s.tags,
              body: s.body,
              dirPath: s.dirPath,
              resources: s.resources.map((r) => ({
                relPath: r.relPath,
                size: r.size,
              })),
            }
          : null;
      },
      list: () => this.skillRegistry.getIndex(),
    });

    // Bundled agent templates. Read-once snapshot of `packages/agent-catalog/templates/`;
    // no live reload. Importers route through `importAgentFromTemplate`.
    this.agentCatalog = new AgentCatalog();

    // Sweep orphan sessions + tasks left behind by pre-cascade
    // `deleteAgent` calls. Agents are filesystem-backed (no DB FK
    // available), so this is a startup-time application-level GC.
    // After `deleteAgent` was fixed to cascade, this should be a no-op
    // on healthy installs; existing installs with orphans get a clean
    // sweep here.
    this.purgeOrphans();
  }

  /**
   * One-shot orphan cleanup: any session whose `agent_id` no longer
   * matches an agent on disk, and any task whose `assignee` is gone,
   * gets deleted. Idempotent. Logs a single summary line per run.
   */
  private purgeOrphans(): void {
    const knownAgentIds = new Set(this.agentStore.list().map((a) => a.id));
    const allSessions = this.sessionStore.listAllActive();
    const orphanSessions = allSessions.filter(
      (s) => !knownAgentIds.has(s.agentId)
    );
    const orphanTasks = this.taskStore
      .list()
      .filter((t) => !knownAgentIds.has(t.assignee));
    if (orphanSessions.length === 0 && orphanTasks.length === 0) return;
    for (const s of orphanSessions) {
      try {
        this.sessionStore.delete(s.id);
      } catch (e) {
        console.warn(
          `purgeOrphans: failed to drop session ${s.id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    // Tasks: best-effort delete with force. TaskStore.delete is async
    // (file IO) — fire and let it settle in the background; ordering
    // doesn't matter and we don't block startup.
    void (async () => {
      for (const t of orphanTasks) {
        try {
          await this.taskStore.delete(t.id, {
            force: true,
            actor: "system:purge-orphans",
          });
        } catch (e) {
          console.warn(
            `purgeOrphans: failed to drop task ${t.id}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    })();
    console.log(
      `Workforce GC: cleaned ${orphanSessions.length} orphan session(s) and ${orphanTasks.length} orphan task(s) from deleted agents.`
    );
  }

  /**
   * Initialize MCP connections for every agent at boot.
   *
   * Each agent gets its own `MCPClient` so per-agent disable/private
   * servers don't leak across agents and so `disconnectServer` on one
   * agent leaves the others untouched.
   */
  async initMCP(): Promise<void> {
    // Parallelize across agents — each gets its own MCPClient and connects
    // independently, so there's no shared state to serialize on. Cuts boot
    // time roughly N× for N agents pointing at the same servers.
    await Promise.all(
      this.agentStore
        .list()
        .map((def) => this.reinitMCPForAgent(def.id))
    );
  }

  /**
   * Resolve the effective server set for one agent:
   *   (global mcp.json) − agentDef.mcpDisabled  ∪  agentDef.mcpServers
   *
   * No merging by name. Collisions are rejected on agent-store write,
   * so the only way they reach here is a hand-edit of mcp.json after
   * the agent was saved — log and skip the global one to avoid
   * silently shadowing the user's per-agent intent.
   */
  serversForAgent(def: AgentDefinition): Record<string, MCPServerConfig> {
    const global = loadGlobalMcpServers(this.config.dataDir);
    const disabled = new Set(def.mcpDisabled ?? []);
    const out: Record<string, MCPServerConfig> = {};

    for (const [name, cfg] of Object.entries(global)) {
      if (disabled.has(name)) continue;
      // Defensive only — agent-store rejects this collision on write,
      // so it'd take an out-of-band hand-edit to mcp.json AFTER the agent
      // was saved to land here. Skip silently; the user's intent (the
      // private entry) wins on the next save round-trip.
      if (Object.prototype.hasOwnProperty.call(def.mcpServers ?? {}, name)) {
        continue;
      }
      out[name] = cfg;
    }
    for (const [name, cfg] of Object.entries(def.mcpServers ?? {})) {
      out[name] = cfg;
    }
    return out;
  }

  /**
   * Tear down and rebuild the MCP client for one agent. Called from
   * `initMCP` and agent CRUD. (No file watcher: editing `mcp.json`
   * requires a server restart by design — simpler model than reasoning
   * about hot reload races.)
   */
  async reinitMCPForAgent(id: string): Promise<void> {
    const def = this.agentStore.get(id);
    if (!def) {
      // Agent may have been deleted between the change event and the
      // reinit — disconnect any leftover client and bail.
      const stale = this.mcpClients.get(id);
      if (stale) {
        await stale.disconnect();
        this.mcpClients.delete(id);
      }
      return;
    }

    const existing = this.mcpClients.get(id);
    if (existing) {
      await existing.disconnect();
      this.mcpClients.delete(id);
    }

    const servers = this.serversForAgent(def);
    if (Object.keys(servers).length === 0) {
      // Drop the cached Agent so any tool change (not just MCP) lands
      // on the next chat call.
      this.agents.delete(id);
      return;
    }

    const mcpClient = new MCPClient(toolRegistry, {
      tokenStore: this.mcpTokenStore(),
      oauthRedirectUrl: this.mcpOAuthRedirectUrl(),
      onUnauthorized: this.mcpOAuthCallback,
    });
    // Boot/reinit don't drive the browser flow — they'd block for up to
    // 5min waiting for the loopback. Servers needing auth land in
    // `awaiting_oauth`; the user explicitly hits the connect endpoint
    // (which omits skipOAuth) to authorize.
    await mcpClient.connect(servers, { skipOAuth: true });
    this.mcpClients.set(id, mcpClient);

    // System prompt + tool list both depend on MCP discovery — evict
    // the cached Agent so the next chat picks up the new tool set.
    // Per-server state (connected/failed/awaiting_oauth/lastError) lives
    // in `getStatus()` for callers that want to surface it.
    this.agents.delete(id);
  }

  /**
   * MCP server status, optionally scoped to one agent.
   */
  getMcpStatus(agentId?: string): Array<{ agentId: string; servers: ServerStatus[] }> {
    const ids = agentId ? [agentId] : [...this.mcpClients.keys()];
    return ids.map((id) => ({
      agentId: id,
      servers: this.mcpClients.get(id)?.getStatus() ?? [],
    }));
  }

  /**
   * Direct access to a per-agent MCP client. Used by per-server
   * connect/disconnect/test routes that need to touch the live client.
   */
  getMcpClient(agentId: string): MCPClient | undefined {
    return this.mcpClients.get(agentId);
  }

  /**
   * Wipe stored OAuth tokens for one MCP server. Used by the reauth
   * endpoint — next connect will trigger a fresh browser flow.
   */
  async clearMcpOAuthTokens(serverName: string): Promise<void> {
    await this.mcpTokenStore().deleteTokens(serverName);
  }

  /**
   * Resolve an agent's effective model. Per-agent `model` overrides the
   * root `config.yaml` model; missing per-agent → fall back to root.
   * `AgentDefinitionSchema.model` is intentionally optional so we can
   * detect "user didn't override" here instead of baking in the schema's
   * hardcoded defaults.
   */
  private resolveModel(def: AgentDefinition): ModelConfig {
    return def.model ?? this.config.model;
  }

  /**
   * Return an agent def with `model` resolved against the root config.
   * Called on every list/get boundary so callers (HTTP, web, internal)
   * see a fully-populated model regardless of whether the AGENT.md
   * file specified one. The returned type narrows `model` to non-optional.
   */
  private withResolvedModel(
    def: AgentDefinition
  ): AgentDefinition & { model: ModelConfig } {
    return def.model
      ? (def as AgentDefinition & { model: ModelConfig })
      : { ...def, model: this.config.model };
  }

  /**
   * Get or lazily create an Agent instance.
   */
  getAgent(id: string): Agent {
    let agent = this.agents.get(id);
    if (!agent) {
      const def = this.agentStore.get(id);
      if (!def) throw new Error(`Agent not found: ${id}`);
      agent = this.createAgentFromDef(def);
      this.agents.set(id, agent);
    }
    return agent;
  }

  /**
   * Get an agent definition with its effective model resolved.
   */
  getAgentDef(
    id: string
  ): (AgentDefinition & { model: ModelConfig }) | null {
    const def = this.agentStore.get(id);
    return def ? this.withResolvedModel(def) : null;
  }

  /**
   * List all agent definitions with their effective models resolved.
   */
  listAgents(): (AgentDefinition & { model: ModelConfig })[] {
    return this.agentStore.list().map((def) => this.withResolvedModel(def));
  }

  /**
   * Create a new agent definition. If MCP servers are configured (global
   * or private), we reinit MCP so the new agent picks them up immediately.
   */
  async createAgent(def: AgentDefinition): Promise<Agent> {
    this.agentStore.upsert(def);
    await this.reinitMCPForAgent(def.id);
    const agent = this.createAgentFromDef(def);
    this.agents.set(def.id, agent);
    return agent;
  }

  /**
   * Update an existing agent definition. Reinit MCP if the change touched
   * any MCP-relevant field — otherwise just evict the cached Agent.
   */
  async updateAgent(
    id: string,
    updates: Partial<AgentDefinition>
  ): Promise<AgentDefinition> {
    const existing = this.agentStore.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);

    const updated: AgentDefinition = {
      ...existing,
      ...updates,
      id,
      // Deep-merge model so partial callers (e.g. model picker sending only
      // {provider, model}) don't clobber auth/apiKey/baseUrl/headers.
      model: updates.model
        ? { ...existing.model, ...updates.model }
        : existing.model,
    };
    this.agentStore.upsert(updated);

    const mcpChanged =
      hasOwn(updates, "mcpServers") || hasOwn(updates, "mcpDisabled");

    if (mcpChanged) {
      await this.reinitMCPForAgent(id);
    } else {
      // Tool list / persona / model only — just evict the cached Agent.
      this.agents.delete(id);
    }

    return updated;
  }

  /**
   * Delete an agent. Cascades to:
   *  - All sessions owned by this agent (their messages cascade via FK,
   *    their attachment dirs via SessionStore.delete's FS hook).
   *  - All tasks assigned to or created by this agent.
   *  - The agent's broadcaster ring buffers.
   *  - The MCP client (so stdio subprocesses don't leak).
   *
   * Agents are filesystem-backed (not a DB row) so the FK route isn't
   * available — this is application-level cascade. Without it, deleting
   * an agent leaves orphan sessions whose `agent_id` references a
   * vanished folder; on every daemon restart the scheduler tries to
   * wake them and warns about the missing agent. Same for tasks
   * assigned to the deleted agent — they'd sit forever as zombies.
   */
  async deleteAgent(id: string): Promise<void> {
    const mcpClient = this.mcpClients.get(id);
    if (mcpClient) {
      await mcpClient.disconnect();
      this.mcpClients.delete(id);
    }
    this.agents.delete(id);

    // Sessions: list cross-agent leaves then filter; SessionStore.list
    // is per-agent so we can use it directly here.
    const sessions = this.sessionStore.list(id);
    for (const s of sessions) {
      try {
        this.broadcaster.forget(s.id);
        this.sessionStore.delete(s.id);
      } catch (e) {
        console.warn(
          `deleteAgent: failed to drop session ${s.id} for ${id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    // Tasks: anything assigned to or created by this agent. We delete
    // rather than reassign — there's no obvious target, and a future
    // operator can recreate the work after they re-create the agent
    // if needed. Force the cascade to also drop dependents.
    const owned = this.taskStore.list({ assignee: id });
    const created = this.taskStore
      .list({ created_by: id })
      .filter((t) => t.assignee !== id);
    for (const t of [...owned, ...created]) {
      try {
        await this.taskStore.delete(t.id, {
          force: true,
          actor: "system:agent-delete",
        });
      } catch (e) {
        console.warn(
          `deleteAgent: failed to drop task ${t.id} for ${id}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    this.agentStore.delete(id);
  }

  /** Drop the cached `Agent` for `id`. The next chat call rebuilds it,
   *  which re-walks resources, re-collects MCP tool names, and rebuilds
   *  the system prompt. Use after any change that affects what
   *  `createAgentFromDef` would produce — including resource mutations.
   */
  evictAgent(id: string): void {
    this.agents.delete(id);
  }

  /** For events emitted by TaskStore before the new sessionId column
   *  was always populated, derive the session from the task's current
   *  binding so SSE fan-out still routes correctly. New emits in the
   *  store layer pass sessionId explicitly; this is a fallback. */
  private deriveSessionForEvent(event: {
    taskId: string | null;
    sessionId: string | null;
  }): string | null {
    if (event.sessionId) return event.sessionId;
    if (!event.taskId) return null;
    const task = this.taskStore.get(event.taskId);
    return task?.session_id ?? null;
  }

  /**
   * Import a bundled agent template:
   *   1. Install recommended skills via SkillHub (skip already-installed; failures collected, never throw).
   *   2. Add recommended MCP servers to global mcp.json (skip name collisions).
   *   3. Build the AgentDefinition + createAgent (existing path — handles MCP reinit + cache).
   *   4. Copy template resources into <agentDir>/resources/, then evict the cached
   *      Agent so the next chat picks up the resource listing in its prompt.
   *
   * Multi-instance: the same template can be imported repeatedly; the id
   * auto-increments off `default_id_hint`. Each instance gets its own
   * folder, memory, sessions, and tasks queue.
   */
  async importAgentFromTemplate(
    templateId: string,
    opts: { idOverride?: string; nameOverride?: string; overrides?: Partial<AgentDefinition> }
  ): Promise<{ agent: AgentDefinition; manifest: ImportManifest }> {
    const template = this.agentCatalog.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    const manifest: ImportManifest = {
      agent: { id: "", resourceFiles: [] },
      workforce: { skills: [], mcpServers: [] },
    };

    // Stage 1a — bundled skills.
    // SkillHub is the single source of truth for "is this installed". An
    // in-process SkillRegistry pre-check would short-circuit the heal path
    // when the registry has a stale view (e.g. skill files removed by hand
    // since boot). Always call install and translate the outcome.
    if (template.bundledSkills.length > 0) {
      const skillsDir = path.isAbsolute(this.config.skills.directory)
        ? this.config.skills.directory
        : path.join(this.config.dataDir, this.config.skills.directory);
      const hub = new SkillHub(skillsDir, this.skillRegistry);
      for (const s of template.bundledSkills) {
        try {
          await hub.install(s.identifier, {
            source: s.source,
            nameOverride: s.name,
          });
          manifest.workforce.skills.push({ name: s.name, action: "installed" });
        } catch (err) {
          // ALREADY_INSTALLED — lockfile + disk agree the skill is there.
          // User's intent met; record kept, not failed.
          if (err instanceof HubError && err.code === "ALREADY_INSTALLED") {
            manifest.workforce.skills.push({ name: s.name, action: "kept" });
            continue;
          }
          manifest.workforce.skills.push({
            name: s.name,
            action: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Stage 1b — recommended MCP servers
    if (template.bundledMcpServers.length > 0) {
      const globalMcp = loadGlobalMcpServers(this.config.dataDir);
      let changed = false;
      for (const m of template.bundledMcpServers) {
        if (Object.prototype.hasOwnProperty.call(globalMcp, m.name)) {
          manifest.workforce.mcpServers.push({ name: m.name, action: "kept" });
          continue;
        }
        globalMcp[m.name] = m.config;
        changed = true;
        manifest.workforce.mcpServers.push({ name: m.name, action: "added" });
      }
      if (changed) {
        saveGlobalMcpServers(this.config.dataDir, globalMcp);
        // Re-discover MCP tools for every agent — `serversForAgent` reads
        // mcp.json fresh on each reinit, so existing agents pick up the
        // new entry too.
        await this.initMCP();
      }
    }

    // Stage 2 — materialize the agent folder
    const existingIds = new Set(this.agentStore.list().map((d) => d.id));
    let def: AgentDefinition;
    try {
      def = buildAgentFromTemplate(template, opts, existingIds);
    } catch (err) {
      if (err instanceof TemplateImportError) {
        throw new Error(err.message);
      }
      throw err;
    }
    await this.createAgent(def);

    // Resources go in after createAgent so the agent folder exists.
    const dir = this.agentStore.agentDir(def.id);
    if (dir) {
      for (const r of template.resources) {
        const dest = path.join(dir, "resources", r.relPath);
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(r.absPath, dest);
          manifest.agent.resourceFiles.push({
            relPath: r.relPath,
            size: r.size,
          });
        } catch (err) {
          console.warn(
            `[agent-catalog] copy ${r.relPath} → ${dest} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
    manifest.agent.id = def.id;
    // Resources changed after createAgent ran; rebuild prompt on next chat.
    this.evictAgent(def.id);

    return { agent: def, manifest };
  }

  /** Current AGENTS.md content, or undefined when the file is absent. */
  getAgentsMd(): string | undefined {
    return this.agentsMd;
  }

  /** Set AGENTS.md content. Empty/whitespace deletes the file. Evicts
   *  cached Agents so next activation rebuilds the system prompt. */
  setAgentsMd(content: string): void {
    writeAgentsMd(this.config.dataDir, content);
    this.agentsMd = readAgentsMd(this.config.dataDir);
    this.agents.clear();
  }

  private createAgentFromDef(def: AgentDefinition): Agent {
    // Collect MCP tool names for this agent. `getStatus` now includes
    // disabled/failed/disconnected entries (their tool list is empty),
    // so filter to actively connected servers — explicit > implicit.
    const mcpToolNames: string[] = [];
    const mcpClient = this.mcpClients.get(def.id);
    if (mcpClient) {
      for (const status of mcpClient.getStatus()) {
        if (!status.connected) continue;
        mcpToolNames.push(...status.tools);
      }
    }

    // Compute skills index for system prompt injection
    let skillsIndex: string | undefined;
    if (def.skills && def.skills.length > 0) {
      // Filter to agent-specified skills only
      const filtered = this.skillRegistry
        .getIndex()
        .filter((s: SkillIndexEntry) => def.skills.includes(s.name));
      if (filtered.length > 0) {
        skillsIndex = filtered
          .map(
            (e: SkillIndexEntry) =>
              `- **${e.name}**: ${e.description}${e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : ""}`
          )
          .join("\n");
      }
    } else if (this.skillRegistry.size > 0) {
      // No filter specified — include all skills
      skillsIndex = this.skillRegistry.getIndexAsString();
    }

    const b = this.config.behavior;
    // Per-agent workspace dir — default cwd for filesystem/shell tools.
    // Idempotent recursive mkdir migrates pre-existing agents on first load.
    const workspaceDir = path.join(this.agentsDir, def.id, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    // Resolve the agent's effective model against the root config
    // before building. Per-agent `model` overrides; absent → root.
    const effectiveModel = this.resolveModel(def);
    // Look up the agent's model in the bundled registry once at
    // AgentConfig build time. The runtime compressor only sees the
    // resolved contextWindow — it never has to know about the snapshot.
    const metadata = lookupModelMetadata(effectiveModel);
    // User-supplied files under `<agentDir>/resources/`. Walked once at
    // AgentConfig build time; the cached system prompt mirrors that
    // snapshot. Mutations via the HTTP route call `evictAgent` so the
    // next chat rebuilds with fresh listings.
    const resources = this.agentStore
      .listResources(def.id)
      .map((r) => ({ relPath: r.relPath, size: r.size, absPath: r.path }));

    const agentConfig: AgentConfig = {
      id: def.id,
      name: def.name,
      model: effectiveModel,
      persona: def.persona,
      // Effective tool set: user-configurable env tools + agent's MCP
      // tools + always-on system tools (skill_view, memory, session_search,
      // task_*). Dedup defensively in case a legacy AGENT.md still lists
      // a system tool explicitly.
      tools: Array.from(
        new Set([...def.tools, ...mcpToolNames, ...SYSTEM_TOOLS])
      ),
      maxSteps: b.maxSteps,
      skillsIndex,
      compression: {
        thresholdTokens: b.compressionThresholdTokens,
        thresholdPercent: b.compressionThresholdPercent,
        contextWindow: metadata.contextWindow ?? null,
        protectFirstN: b.compressionProtectFirstN,
        tailTokenBudget: b.compressionTailTokenBudget,
        summaryTargetRatio: b.compressionSummaryTargetRatio,
        summarizerInputCharBudget: b.compressionSummarizerInputCharBudget,
        summarizerModel: b.compressionSummarizerModel,
      },
      agentsMd: this.agentsMd,
      workspaceDir,
      resources,
    };

    return new Agent(agentConfig, {
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      toolRegistry,
      attachmentsRoot: this.attachmentsRoot,
      memoryStore: this.memoryStore,
      taskStore: this.taskStore,
      broadcaster: this.broadcaster,
    });
  }

  // ── MCP OAuth wiring ─────────────────────────────────────────────────────
  //
  // `MCPClient` is provider-agnostic — it doesn't import `@openacme/auth`.
  // The pieces below are AgentManager's OS-side glue: a file-backed token
  // store under `<dataDir>/mcp-tokens/`, a loopback URL for the OAuth
  // callback, and a callback that runs the browser flow via the existing
  // `@openacme/auth` primitives.

  private _mcpTokenStore?: MCPTokenStore;
  private _mcpLoopbackPort = 17331;

  private mcpTokenStore(): MCPTokenStore {
    if (!this._mcpTokenStore) {
      this._mcpTokenStore = new FileMCPTokenStore(
        path.join(this.config.dataDir, "mcp-tokens")
      );
    }
    return this._mcpTokenStore;
  }

  private mcpOAuthRedirectUrl(): string {
    return `http://127.0.0.1:${this._mcpLoopbackPort}/auth/callback`;
  }

  /**
   * Drive the OAuth flow when `MCPClient` hits an `UnauthorizedError`.
   * Prints the URL (so it's never lost on a failed browser open),
   * launches the system browser when not headless, and waits for the
   * loopback callback to resolve with the auth code.
   */
  private mcpOAuthCallback: OAuthCallback = async ({
    serverName,
    authorizationUrl,
    redirectUrl,
  }) => {
    // The MCP SDK omits `state` from the authorization request — OAuth 2.1
    // PKCE alone covers CSRF, and `state` is optional. Pass `expectedState:
    // ""` so the loopback skips state validation and accepts a callback
    // with just `?code=...`. (If a server DOES echo back state we'll
    // accept whatever it sends; PKCE is what binds it to our session.)
    const sdkState = authorizationUrl.searchParams.get("state") ?? "";

    const url = authorizationUrl.toString();
    // Open the system browser when we can. Headless callers (SSH, CI) are
    // expected to drive auth from a separate channel — this code path is
    // synchronous-await on the loopback, so a non-TTY caller has already
    // chosen to wait. We don't print to stdout because the CLI may be
    // running an Ink TUI; the URL is also returned to API callers via the
    // `awaiting_oauth` state on `getStatus()`.
    if (!looksHeadless()) openBrowser(url);

    try {
      const { code } = await awaitLoopbackCallback({
        port: this._mcpLoopbackPort,
        expectedState: sdkState,
        callbackPath: "/auth/callback",
        timeoutMs: 5 * 60_000,
      });
      void redirectUrl;
      return { code };
    } catch {
      return { cancelled: true };
    }
  };

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    // Order matters: stop the scheduler so no new turns start, then
    // wait for any in-flight turn chains to drain before closing the
    // DB. Without the drain, an autonomous turn still mid-write hits a
    // closed sqlite handle ("The database connection is not open") at
    // exit. Particularly visible in CLI chat where the scheduler runs
    // in-process and a turn may have been kicked just before exit.
    this.taskScheduler.stop();
    await this.taskScheduler.drain();
    for (const [_, mcpClient] of this.mcpClients) {
      await mcpClient.disconnect();
    }
    closeAllShellSessions();
    await this.browserManager.close();
    this.db.close();
  }
}

function hasOwn<T extends object>(obj: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Structured "what landed where" record returned by `importAgentFromTemplate`.
 * Two-bucket shape: contents of the agent folder vs. workforce-wide installs.
 */
export interface ImportManifest {
  agent: {
    id: string;
    resourceFiles: Array<{ relPath: string; size: number }>;
  };
  workforce: {
    skills: Array<
      | { name: string; action: "installed" | "kept" }
      | { name: string; action: "failed"; error: string }
    >;
    mcpServers: Array<{ name: string; action: "added" | "kept" }>;
  };
}
