import { Agent, type AgentConfig, type StreamChunk } from "@openacme/agent-core";
import type { AgentDefinition, Config } from "@openacme/config";
import {
  createDatabase,
  createSessionStore,
  createMessageStore,
  createAgentStore,
  type SessionStore,
  type MessageStore,
  type AgentStore,
} from "@openacme/db";
import { registry as toolRegistry } from "@openacme/tools";
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
    this.agentStore = createAgentStore(this.db);

    // Load skills
    this.skillRegistry = new SkillRegistry();
    const skillsDir = path.isAbsolute(config.skills.directory)
      ? config.skills.directory
      : path.join(config.dataDir, config.skills.directory);
    this.skillRegistry.loadFromDirectory(skillsDir);
    if (this.skillRegistry.size > 0) {
      console.log(`  📚 Loaded ${this.skillRegistry.size} skills`);
    }

    // Sync agent definitions from config to DB
    this.agentStore.syncFromConfig(config.agents);
  }

  /**
   * Initialize MCP connections for all agents that have MCP servers configured.
   * Called after construction (async init).
   */
  async initMCP(): Promise<void> {
    for (const agentDef of this.config.agents) {
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
   */
  async *chat(
    agentId: string,
    sessionId: string,
    message: string
  ): AsyncIterable<StreamChunk> {
    const agent = this.getAgent(agentId);
    yield* agent.chat(sessionId, message);
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

    const agentConfig: AgentConfig = {
      id: def.id,
      name: def.name,
      model: def.model,
      persona: def.persona,
      tools: [...def.tools, ...mcpToolNames],
      maxSteps: this.config.behavior.maxSteps,
      skillsIndex,
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
