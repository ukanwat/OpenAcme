import type { Hono } from "hono";
import {
  AgentDefinitionSchema,
  loadGlobalMcpServers,
  type AgentDefinition,
  type Config,
} from "@openacme/config";
import type { AgentManager } from "../agent-manager.js";

/**
 * Routes for the bespoke agent catalog — bundled templates the user can
 * import into their workforce. Reads come straight from the in-memory
 * `AgentCatalog`. Writes (`/import`) route through
 * `AgentManager.importAgentFromTemplate`, which handles the workforce-wide
 * installs (skills via SkillHub, MCP via global mcp.json) and materializes
 * the agent folder (AGENT.md + resources/).
 */
export function registerAgentCatalogRoutes(
  app: Hono,
  manager: AgentManager,
  config: Config
): void {
  // GET /api/agents/catalog — list templates with summary counts
  app.get("/api/agents/catalog", (c) => {
    return c.json(manager.agentCatalog.list());
  });

  // GET /api/agents/catalog/:templateId — full template (persona body + tools + recommended_*)
  app.get("/api/agents/catalog/:templateId", (c) => {
    const id = c.req.param("templateId");
    const t = manager.agentCatalog.get(id);
    if (!t) return c.json({ error: "template not found" }, 404);
    return c.json({
      meta: t.meta,
      agentFields: t.agentFields,
      // Strip absolute paths from resource refs — the client doesn't need
      // them and they leak the install path.
      resources: t.resources.map((r) => ({
        relPath: r.relPath,
        size: r.size,
      })),
      recommendedSkills: t.recommendedSkills,
      recommendedMcpServers: t.recommendedMcpServers,
    });
  });

  // GET /api/agents/catalog/:templateId/preview — diff against current state
  // ("new" vs "kept") so the UI can render the install summary without
  // performing the import.
  app.get("/api/agents/catalog/:templateId/preview", (c) => {
    const id = c.req.param("templateId");
    const t = manager.agentCatalog.get(id);
    if (!t) return c.json({ error: "template not found" }, 404);

    const installedSkillNames = new Set(
      manager.skillRegistry.getIndex().map((s) => s.name)
    );
    const installedAgentIds = new Set(
      manager.agentStore.list().map((a) => a.id)
    );
    const globalMcp = loadGlobalMcpServers(config.dataDir);

    // Predict the id buildAgentFromTemplate would assign. Mirrors the
    // auto-increment logic in @openacme/agent-catalog so the UI can show
    // the resolved id in the preview without performing the import.
    let assignedId = t.meta.defaultIdHint;
    if (installedAgentIds.has(assignedId)) {
      let n = 2;
      while (installedAgentIds.has(`${t.meta.defaultIdHint}-${n}`)) n += 1;
      assignedId = `${t.meta.defaultIdHint}-${n}`;
    }

    return c.json({
      templateId: t.meta.id,
      assignedId,
      agent: {
        name: t.agentFields.name,
        resourceFiles: t.resources.map((r) => ({
          relPath: r.relPath,
          size: r.size,
        })),
      },
      workforce: {
        skills: t.recommendedSkills.map((s) => ({
          name: s.name,
          source: s.source,
          identifier: s.identifier,
          status: installedSkillNames.has(s.name) ? "kept" : "new",
        })),
        mcpServers: t.recommendedMcpServers.map((m) => ({
          name: m.name,
          status: Object.prototype.hasOwnProperty.call(globalMcp, m.name)
            ? "kept"
            : "new",
        })),
      },
    });
  });

  // POST /api/agents/catalog/:templateId/import — performs the install
  app.post("/api/agents/catalog/:templateId/import", async (c) => {
    const templateId = c.req.param("templateId");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const idOverride =
      typeof body.idOverride === "string"
        ? body.idOverride.trim()
        : undefined;
    const nameOverride =
      typeof body.nameOverride === "string"
        ? body.nameOverride.trim()
        : undefined;

    let overrides: Partial<Omit<AgentDefinition, "id">> | undefined;
    if (body.overrides && typeof body.overrides === "object") {
      // Strip any `id` key from overrides — id is owned by buildAgentFromTemplate.
      const raw = { ...(body.overrides as Record<string, unknown>) };
      delete raw.id;
      // `.partial()` makes every field optional so partial overrides validate.
      const parsed = AgentDefinitionSchema.partial().safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: `invalid overrides: ${parsed.error.message}` },
          400
        );
      }
      overrides = parsed.data as Partial<Omit<AgentDefinition, "id">>;
    }

    try {
      const result = await manager.importAgentFromTemplate(templateId, {
        idOverride,
        nameOverride,
        overrides,
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/template not found/i.test(msg)) {
        return c.json({ error: msg }, 404);
      }
      return c.json({ error: msg }, 400);
    }
  });
}
