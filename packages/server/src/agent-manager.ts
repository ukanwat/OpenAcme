import { Agent, type AgentConfig, type StreamChunk } from "@openacme/agent-core";
import {
  createAgentStore,
  lookupModelMetadata,
  type AgentDefinition,
  type AgentStore,
  type Config,
} from "@openacme/config";
import {
  createDatabase,
  createSessionStore,
  createMessageStore,
  type SessionStore,
  type MessageStore,
} from "@openacme/db";
import {
  registry as toolRegistry,
  bindSessionSearch,
  bindSkillView,
} from "@openacme/tools";
import { MCPClient } from "@openacme/mcp-client";
import { SkillRegistry, type SkillIndexEntry } from "@openacme/skills";
import * as path from "node:path";

/**
 * AgentManager — manages multiple agent instances, MCP connections, and skills.
 * Routes chat requests to the correct agent.
 */
export class AgentManager {
  private agents = new Map<string, Agent>();
  private db: ReturnType<typeof createDatabase>;
  readonly sessionStore: SessionStore;
  readonly messageStore: MessageStore;
  readonly agentStore: AgentStore;
  private config: Config;
  private mcpClients = new Map<string, MCPClient>();
  readonly skillRegistry: SkillRegistry;

  constructor(config: Config) {
    this.config = config;
    this.db = createDatabase(config);
    this.sessionStore = createSessionStore(this.db);
    this.messageStore = createMessageStore(this.db);

    // Agents live as folders at <dataDir>/agents/<id>/AGENT.md — the
    // directory is the only source of truth, no DB mirror, no shadow
    // state in config.yaml.
    const agentsDir = path.join(config.dataDir, "agents");
    this.agentStore = createAgentStore(agentsDir);

    // Wire the FTS5-backed cross-session search into the `session_search`
    // tool. Done here so @openacme/tools doesn't need a runtime dep on
    // @openacme/db. `resolveRoot` lets the tool collapse compression chains
    // back to one root and exclude the current conversation's lineage.
    bindSessionSearch({
      search: (query, limit) => this.messageStore.search(query, limit),
      resolveRoot: (sessionId) => this.sessionStore.getRoot(sessionId),
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
  }

  /**
   * Initialize MCP connections for all agents that have MCP servers configured.
   * Called after construction (async init).
   */
  async initMCP(): Promise<void> {
    for (const agentDef of this.agentStore.list()) {
      const servers = agentDef.mcpServers;
      if (!servers || Object.keys(servers).length === 0) continue;

      const mcpClient = new MCPClient(toolRegistry);
      const { connected, failed } = await mcpClient.connect(servers);

      if (connected.length > 0) {
        this.mcpClients.set(agentDef.id, mcpClient);
        console.log(`  🔌 Agent '${agentDef.name}': MCP connected → ${connected.join(", ")}`);
      }
      if (failed.length > 0) {
        console.warn(`  ⚠️  Agent '${agentDef.name}': MCP failed → ${failed.join(", ")}`);
      }
    }
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
   * List all agent definitions.
   */
  listAgents(): AgentDefinition[] {
    return this.agentStore.list();
  }

  /**
   * Create a new agent definition.
   */
  createAgent(def: AgentDefinition): Agent {
    this.agentStore.upsert(def);
    const agent = this.createAgentFromDef(def);
    this.agents.set(def.id, agent);
    return agent;
  }

  /**
   * Update an existing agent definition.
   */
  updateAgent(id: string, updates: Partial<AgentDefinition>): AgentDefinition {
    const existing = this.agentStore.get(id);
    if (!existing) throw new Error(`Agent not found: ${id}`);

    const updated = { ...existing, ...updates, id };
    this.agentStore.upsert(updated);

    // Evict cached agent instance so it gets recreated with new config
    this.agents.delete(id);

    return updated;
  }

  /**
   * Delete an agent.
   */
  deleteAgent(id: string): void {
    this.agents.delete(id);
    this.agentStore.delete(id);
  }

  /**
   * Chat with an agent — returns an async iterable for streaming.
   *
   * `opts.signal` cancels the in-flight LLM call; the agent yields a
   * single `{type: "stopped"}` chunk and returns.
   */
  async *chat(
    agentId: string,
    sessionId: string,
    message: string,
    opts?: { signal?: AbortSignal }
  ): AsyncIterable<StreamChunk> {
    const agent = this.getAgent(agentId);
    yield* agent.chat(sessionId, message, opts);
  }

  private createAgentFromDef(def: AgentDefinition): Agent {
    // Collect MCP tool names for this agent
    const mcpToolNames: string[] = [];
    const mcpClient = this.mcpClients.get(def.id);
    if (mcpClient) {
      for (const status of mcpClient.getStatus()) {
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
    // Look up the agent's model in the bundled registry once at
    // AgentConfig build time. The runtime compressor only sees the
    // resolved contextWindow — it never has to know about the snapshot.
    const metadata = lookupModelMetadata(def.model);
    const agentConfig: AgentConfig = {
      id: def.id,
      name: def.name,
      model: def.model,
      persona: def.persona,
      tools: [...def.tools, ...mcpToolNames],
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
    };

    return new Agent(agentConfig, {
      sessionStore: this.sessionStore,
      messageStore: this.messageStore,
      toolRegistry,
    });
  }

  /**
   * Close all connections.
   */
  async close(): Promise<void> {
    for (const [_, mcpClient] of this.mcpClients) {
      await mcpClient.disconnect();
    }
    this.db.close();
  }
}
