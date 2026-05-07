import type Database from "better-sqlite3";
import { AgentDefinitionSchema, type AgentDefinition } from "@openacme/config";

export interface AgentRow {
  id: string;
  name: string;
  config: string; // JSON serialized AgentDefinition
  createdAt: number;
  updatedAt: number;
}

/**
 * Agent store — CRUD for agent definitions in the database.
 */
export function createAgentStore(db: Database.Database) {
  const stmts = {
    upsert: db.prepare(
      `INSERT INTO agents (id, name, config, created_at, updated_at)
       VALUES (?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         config = excluded.config,
         updated_at = unixepoch()`
    ),
    get: db.prepare(
      `SELECT id, name, config, created_at as createdAt, updated_at as updatedAt
       FROM agents WHERE id = ?`
    ),
    list: db.prepare(
      `SELECT id, name, config, created_at as createdAt, updated_at as updatedAt
       FROM agents ORDER BY created_at ASC`
    ),
    delete: db.prepare(`DELETE FROM agents WHERE id = ?`),
  };

  return {
    upsert(agent: AgentDefinition): void {
      stmts.upsert.run(agent.id, agent.name, JSON.stringify(agent));
    },

    get(id: string): AgentDefinition | null {
      const row = stmts.get.get(id) as AgentRow | undefined;
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.config);
        return AgentDefinitionSchema.parse(parsed);
      } catch (e) {
        console.error(`Invalid agent config in database for id '${id}': ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    },

    list(): AgentDefinition[] {
      const rows = stmts.list.all() as AgentRow[];
      const agents: AgentDefinition[] = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.config);
          agents.push(AgentDefinitionSchema.parse(parsed));
        } catch (e) {
          console.error(`Invalid agent config in database for id '${row.id}': ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return agents;
    },

    delete(id: string): void {
      stmts.delete.run(id);
    },

    /**
     * Sync agent definitions from config into the database.
     * Called on server startup to ensure DB matches config.yaml.
     */
    syncFromConfig(agents: AgentDefinition[]): void {
      const syncTx = db.transaction((defs: AgentDefinition[]) => {
        for (const agent of defs) {
          stmts.upsert.run(agent.id, agent.name, JSON.stringify(agent));
        }
      });
      syncTx(agents);
    },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;
