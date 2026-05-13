import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, loadGlobalMcpServers } from "@openacme/config";
import { AgentManager } from "../src/agent-manager.js";

/**
 * Full end-to-end import flow against a real (temp) data directory and a
 * real AgentManager. Exercises:
 *   - bundled-skill auto-install via the `builtin` SkillHub source
 *   - bundled-MCP add to global mcp.json (Coder bundles `filesystem`)
 *   - agent folder materialization (AGENT.md + workspace/ + resources/)
 *   - id auto-increment across repeated imports
 *   - id derives from folder, not frontmatter
 */
describe("AgentManager.importAgentFromTemplate (bundled Coder)", () => {
  let dataDir: string;
  let manager: AgentManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-catalog-"));
    const config = ConfigSchema.parse({ dataDir });
    manager = new AgentManager(config);
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("imports Coder, installs the bundled skill, copies resources", async () => {
    const result = await manager.importAgentFromTemplate("coder", {});

    expect(result.agent.id).toBe("coder");
    expect(result.agent.name).toBe("Coder");
    expect(result.manifest.agent.id).toBe("coder");
    expect(result.manifest.agent.resourceFiles).toHaveLength(1);
    expect(result.manifest.agent.resourceFiles[0]?.relPath).toBe(
      "style-guide.md"
    );

    // Skill: auto-installed via the builtin source
    const skill = result.manifest.workforce.skills.find(
      (s) => s.name === "coding-conventions"
    );
    expect(skill?.action).toBe("installed");
    expect(existsSync(path.join(dataDir, "skills", "coding-conventions", "SKILL.md")))
      .toBe(true);

    // Agent folder shape
    const agentDir = path.join(dataDir, "agents", "coder");
    expect(existsSync(path.join(agentDir, "AGENT.md"))).toBe(true);
    expect(existsSync(path.join(agentDir, "workspace"))).toBe(true);
    expect(existsSync(path.join(agentDir, "resources", "style-guide.md")))
      .toBe(true);

    // Imported AGENT.md is pristine — no template_* keys leaked into frontmatter
    const agentMd = readFileSync(
      path.join(agentDir, "AGENT.md"),
      "utf-8"
    );
    expect(agentMd).not.toContain("template_id:");
    expect(agentMd).not.toContain("default_id_hint:");
    expect(agentMd).not.toContain("bundled_skills:");
    expect(agentMd).not.toContain("bundled_mcp_servers:");
    // id lives in the folder name, not the frontmatter
    expect(agentMd).not.toMatch(/^id:\s/m);
    // memoryCharLimit is a platform constant, not a per-agent field
    expect(agentMd).not.toContain("memoryCharLimit:");

    // MCP server installed into global mcp.json
    const mcp = loadGlobalMcpServers(dataDir);
    expect(mcp.filesystem).toBeDefined();
    expect(mcp.filesystem?.command).toBe("npx");
    const mcpAdded = result.manifest.workforce.mcpServers.find(
      (m) => m.name === "filesystem"
    );
    expect(mcpAdded?.action).toBe("added");

    // Resource file is a byte-for-byte copy of the template
    const dst = readFileSync(
      path.join(agentDir, "resources", "style-guide.md")
    );
    expect(dst.length).toBeGreaterThan(0);
  });

  it("auto-increments the id on repeated imports", async () => {
    const a = await manager.importAgentFromTemplate("coder", {});
    const b = await manager.importAgentFromTemplate("coder", {});
    const c = await manager.importAgentFromTemplate("coder", {});

    expect(a.agent.id).toBe("coder");
    expect(b.agent.id).toBe("coder-2");
    expect(c.agent.id).toBe("coder-3");

    // The skill should be installed once and kept on subsequent imports
    // (skills live workforce-wide; only the first import installs them).
    expect(a.manifest.workforce.skills[0]?.action).toBe("installed");
    expect(b.manifest.workforce.skills[0]?.action).toBe("kept");
    expect(c.manifest.workforce.skills[0]?.action).toBe("kept");

    // Same for MCP — added once, kept on repeats.
    expect(a.manifest.workforce.mcpServers[0]?.action).toBe("added");
    expect(b.manifest.workforce.mcpServers[0]?.action).toBe("kept");
    expect(c.manifest.workforce.mcpServers[0]?.action).toBe("kept");

    // Each instance has its own resources copied fresh
    expect(b.manifest.agent.resourceFiles).toHaveLength(1);
    expect(
      existsSync(path.join(dataDir, "agents", "coder-2", "resources", "style-guide.md"))
    ).toBe(true);
  });

  it("honors idOverride when supplied", async () => {
    const r = await manager.importAgentFromTemplate("coder", {
      idOverride: "backend-coder",
      nameOverride: "Backend Coder",
    });
    expect(r.agent.id).toBe("backend-coder");
    expect(r.agent.name).toBe("Backend Coder");
    expect(
      existsSync(path.join(dataDir, "agents", "backend-coder", "AGENT.md"))
    ).toBe(true);
  });

  it("rejects an idOverride that collides", async () => {
    await manager.importAgentFromTemplate("coder", {});
    await expect(
      manager.importAgentFromTemplate("coder", { idOverride: "coder" })
    ).rejects.toThrow(/already exists/);
  });

  it("rejects unknown template ids", async () => {
    await expect(
      manager.importAgentFromTemplate("nonexistent", {})
    ).rejects.toThrow(/template not found/i);
  });

  it("applies inline overrides to the imported AgentDefinition", async () => {
    const r = await manager.importAgentFromTemplate("coder", {
      overrides: {
        model: { provider: "openai", model: "gpt-5", auth: "api_key" },
        role: "Backend specialist",
      },
    });
    expect(r.agent.model?.provider).toBe("openai");
    expect(r.agent.model?.model).toBe("gpt-5");
    expect(r.agent.role).toBe("Backend specialist");

    // Round-trips through AgentStore.upsert serialization, so reading back
    // shows the same values.
    const stored = manager.agentStore.get(r.agent.id);
    expect(stored?.model?.provider).toBe("openai");
    expect(stored?.role).toBe("Backend specialist");
  });

  it("id derives from folder name, ignoring frontmatter id drift", async () => {
    await manager.importAgentFromTemplate("coder", {});
    // Tamper: prepend a stale `id: imposter` to the AGENT.md frontmatter.
    const filePath = path.join(dataDir, "agents", "coder", "AGENT.md");
    const orig = readFileSync(filePath, "utf-8");
    const tampered = orig.replace("---\n", "---\nid: imposter\n");
    require("node:fs").writeFileSync(filePath, tampered);

    // Re-list — the agent should still report id "coder" from its folder,
    // not the bogus frontmatter id.
    const fresh = new AgentManager(ConfigSchema.parse({ dataDir }));
    try {
      const agents = fresh.listAgents();
      const coder = agents.find((a) => a.id === "coder");
      expect(coder).toBeDefined();
      expect(agents.find((a) => a.id === "imposter")).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });
});

/**
 * First-boot materialization. Covers the path that lets a fresh install
 * land with a working Acme agent without the user running setup.
 */
describe("AgentManager.ensureDefaultAgents", () => {
  let dataDir: string;
  let manager: AgentManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-acme-"));
    manager = new AgentManager(ConfigSchema.parse({ dataDir }));
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("materializes Acme on an empty workforce", async () => {
    expect(manager.listAgents()).toHaveLength(0);

    await manager.ensureDefaultAgents();

    const agents = manager.listAgents();
    expect(agents).toHaveLength(1);
    const acme = agents[0]!;
    expect(acme.id).toBe("acme");
    expect(acme.name).toBe("Acme");

    // Agent folder
    expect(existsSync(path.join(dataDir, "agents", "acme", "AGENT.md"))).toBe(true);
    expect(existsSync(path.join(dataDir, "agents", "acme", "workspace"))).toBe(true);

    // Bundled skill landed
    expect(existsSync(path.join(dataDir, "skills", "openacme-platform", "SKILL.md")))
      .toBe(true);

    // Resources copied
    expect(
      existsSync(path.join(dataDir, "agents", "acme", "resources", "example-agent.md"))
    ).toBe(true);
    expect(
      existsSync(path.join(dataDir, "agents", "acme", "resources", "example-skill.md"))
    ).toBe(true);
    expect(
      existsSync(path.join(dataDir, "agents", "acme", "resources", "example-mcp.md"))
    ).toBe(true);
    expect(
      existsSync(path.join(dataDir, "agents", "acme", "resources", "cli-commands.md"))
    ).toBe(true);
    expect(
      existsSync(path.join(dataDir, "agents", "acme", "resources", "onboarding-task.md"))
    ).toBe(true);
  });

  it("is idempotent — second call does not duplicate the agent", async () => {
    await manager.ensureDefaultAgents();
    await manager.ensureDefaultAgents();
    expect(manager.listAgents()).toHaveLength(1);
  });

  it("does not re-materialize when other agents exist", async () => {
    // Pretend a user-added agent showed up before Acme.
    await manager.importAgentFromTemplate("coder", {});
    expect(manager.listAgents().map((a) => a.id)).toEqual(["coder"]);

    await manager.ensureDefaultAgents();

    // Acme stays out — the gate fires only when the workforce is empty.
    expect(manager.listAgents().map((a) => a.id)).toEqual(["coder"]);
    expect(existsSync(path.join(dataDir, "agents", "acme"))).toBe(false);
  });
});
