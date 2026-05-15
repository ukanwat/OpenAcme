import { describe, it, expect } from "vitest";
import { AgentCatalog } from "../src/catalog.js";
import {
  buildAgentFromTemplate,
  TemplateImportError,
} from "../src/import.js";

describe("AgentCatalog (bundled templates)", () => {
  const catalog = new AgentCatalog();

  it("lists the bundled Coder template", () => {
    const list = catalog.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const coder = list.find((m) => m.id === "coder");
    expect(coder).toBeDefined();
    expect(coder?.name).toBe("Coder");
    expect(coder?.tags).toContain("engineering");
    // Coder ships with one recommended skill, no MCP servers, and one
    // resource file (style-guide.md). Hard-coded counts catch regressions
    // if someone edits the template without updating the test.
    expect(coder?.counts.skills).toBe(1);
    expect(coder?.counts.mcpServers).toBe(0);
    expect(coder?.counts.resources).toBe(1);
  });

  it("returns the full template via get()", () => {
    const t = catalog.get("coder");
    expect(t).toBeDefined();
    expect(t?.agentFields.name).toBe("Coder");
    expect(t?.agentFields.skills).toContain("coding-conventions");
    expect(t?.agentFields.tools).toContain("shell");
    expect(t?.agentFields.persona.length).toBeGreaterThan(50);
    expect(t?.recommendedSkills[0]?.name).toBe("coding-conventions");
    expect(t?.recommendedSkills[0]?.source).toBe("builtin");
    expect(t?.resources[0]?.relPath).toBe("style-guide.md");
    expect(t?.resources[0]?.size).toBeGreaterThan(0);
  });

  it("returns undefined for unknown template ids", () => {
    expect(catalog.get("nonexistent")).toBeUndefined();
  });
});

describe("buildAgentFromTemplate", () => {
  const catalog = new AgentCatalog();
  const coder = catalog.get("coder");
  if (!coder) throw new Error("Coder template missing — fix the bundled catalog");

  it("assigns the default_id_hint when no override and no collision", () => {
    const def = buildAgentFromTemplate(coder, {}, new Set());
    expect(def.id).toBe("coder");
    expect(def.name).toBe("Coder");
    expect(def.tools).toContain("shell");
  });

  it("auto-increments the id when the hint is taken", () => {
    const def = buildAgentFromTemplate(coder, {}, new Set(["coder"]));
    expect(def.id).toBe("coder-2");
  });

  it("skips over existing suffixed ids", () => {
    const existing = new Set(["coder", "coder-2", "coder-3"]);
    const def = buildAgentFromTemplate(coder, {}, existing);
    expect(def.id).toBe("coder-4");
  });

  it("respects an explicit idOverride", () => {
    const def = buildAgentFromTemplate(
      coder,
      { idOverride: "backend-coder" },
      new Set(["coder"])
    );
    expect(def.id).toBe("backend-coder");
  });

  it("rejects an invalid idOverride", () => {
    expect(() =>
      buildAgentFromTemplate(coder, { idOverride: "has spaces" }, new Set())
    ).toThrow(TemplateImportError);
  });

  it("rejects an idOverride that collides", () => {
    expect(() =>
      buildAgentFromTemplate(
        coder,
        { idOverride: "coder" },
        new Set(["coder"])
      )
    ).toThrow(TemplateImportError);
  });

  it("applies nameOverride", () => {
    const def = buildAgentFromTemplate(
      coder,
      { nameOverride: "Backend Coder" },
      new Set()
    );
    expect(def.name).toBe("Backend Coder");
    expect(def.id).toBe("coder");
  });

  it("merges overrides into the returned definition", () => {
    const def = buildAgentFromTemplate(
      coder,
      {
        overrides: {
          model: {
            provider: "openai",
            model: "gpt-5",
            auth: "api_key",
          },
        },
      },
      new Set()
    );
    expect(def.model?.provider).toBe("openai");
    expect(def.model?.model).toBe("gpt-5");
  });

  it("strips template_* keys — the imported AGENT.md is pristine", () => {
    const def = buildAgentFromTemplate(coder, {}, new Set());
    // Indirect check: the schema strips unknown keys by default, but the
    // catalog also explicitly separates them — a regression here would
    // surface as a Zod error or as the field being present.
    expect((def as unknown as Record<string, unknown>)["template_id"]).toBeUndefined();
    expect((def as unknown as Record<string, unknown>)["default_id_hint"]).toBeUndefined();
    expect((def as unknown as Record<string, unknown>)["recommended_skills"]).toBeUndefined();
  });
});
