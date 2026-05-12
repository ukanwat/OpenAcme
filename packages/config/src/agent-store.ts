import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { AgentDefinitionSchema, type AgentDefinition } from "./schema.js";
import { loadGlobalMcpServers } from "./mcp-store.js";

/**
 * File-based agent store. Each agent lives in its own folder under
 * `<agentsDir>/<id>/AGENT.md`. Folder layout mirrors the SKILL.md
 * convention used by `@openacme/skills` — gives every agent room for
 * sibling files (custom prompt fragments, examples, attachments) without
 * cluttering the parent directory.
 *
 * AGENT.md format:
 *   ---
 *   id: openai
 *   name: OpenAI Agent
 *   model:
 *     provider: openai
 *     model: gpt-5.5
 *     auth: oauth
 *   tools: [shell, read_file, write_file]
 *   mcpServers: {}
 *   skills: []
 *   ---
 *
 *   You are a helpful AI assistant. ...
 *
 * Structured fields go in the YAML frontmatter; the persona is the
 * markdown body — easier to author multi-paragraph prose than a
 * triple-quoted YAML string.
 */
export interface AgentStore {
  list(): AgentDefinition[];
  get(id: string): AgentDefinition | null;
  upsert(agent: AgentDefinition): void;
  delete(id: string): void;
}

// Folder names must look like a single safe segment — no path traversal,
// no hidden folders, no slashes/dots that would tangle filesystem semantics.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const AGENT_FILE = "AGENT.md";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function agentFolder(rootDir: string, id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid agent id ${JSON.stringify(id)}: must match ${SAFE_ID} (letters/digits/._- only, no leading dot).`
    );
  }
  return path.join(rootDir, id);
}

function agentFile(rootDir: string, id: string): string {
  return path.join(agentFolder(rootDir, id), AGENT_FILE);
}

function parseAgentFile(filePath: string): AgentDefinition | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { data, content: body } = matter(content);
    const trimmedBody = body.trim();
    // Persona may be in frontmatter (legacy) or in body (preferred). Body wins
    // when present so editors get the prose-friendly markdown affordance.
    const persona =
      trimmedBody.length > 0
        ? trimmedBody
        : typeof (data as { persona?: unknown }).persona === "string"
          ? ((data as { persona: string }).persona)
          : "";
    return AgentDefinitionSchema.parse({ ...data, persona });
  } catch (e) {
    console.warn(
      `Skipping malformed agent file ${filePath}: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

// gray-matter delegates to js-yaml, which throws on `undefined` values rather
// than skipping them. Optional schema fields (e.g. `model.baseUrl` for openai,
// where there is no default base URL) reach here as `undefined` and crash the
// serializer mid-write — leaving a half-built agent folder. Strip them here.
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

function serializeAgent(agent: AgentDefinition): string {
  // Persona goes in the body; everything else stays structured in frontmatter.
  // gray-matter.stringify takes (body, frontmatterObj).
  const { persona, ...frontmatter } = stripUndefined(agent);
  return matter.stringify(persona ? `${persona}\n` : "\n", frontmatter);
}

export function createAgentStore(agentsDir: string): AgentStore {
  // Where the global mcp.json lives — the parent of `agents/` is the
  // dataDir per layout convention (see AgentManager construction).
  const dataDir = path.dirname(agentsDir);

  // Per-agent server names must NOT collide with global catalog names.
  // Per-agent is for agent-PRIVATE servers; if the user wants to change a
  // global server's config, they edit mcp.json. If they want to exclude a
  // global server from one agent, they put its name in `mcpDisabled`.
  function assertNoGlobalCollisions(agent: AgentDefinition): void {
    const privateNames = Object.keys(agent.mcpServers ?? {});
    if (privateNames.length === 0) return;
    const global = loadGlobalMcpServers(dataDir);
    const collisions = privateNames.filter((n) =>
      Object.prototype.hasOwnProperty.call(global, n)
    );
    if (collisions.length > 0) {
      throw new Error(
        `Agent '${agent.id}': mcpServers names ${JSON.stringify(collisions)} ` +
          `conflict with the global mcp.json catalog. ` +
          `Either rename the agent-private server, or remove it from mcp.json. ` +
          `To exclude the global server from this agent, add its name to mcpDisabled instead.`
      );
    }
  }

  return {
    list(): AgentDefinition[] {
      if (!fs.existsSync(agentsDir)) return [];
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      const out: AgentDefinition[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        const filePath = path.join(agentsDir, entry.name, AGENT_FILE);
        if (!fs.existsSync(filePath)) continue;
        const def = parseAgentFile(filePath);
        if (def) out.push(def);
      }
      // Stable order — id ascending. Different from DB insertion order, but
      // deterministic; the web UI sorts by name anyway.
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    },

    get(id: string): AgentDefinition | null {
      if (!SAFE_ID.test(id)) return null;
      const filePath = agentFile(agentsDir, id);
      if (!fs.existsSync(filePath)) return null;
      return parseAgentFile(filePath);
    },

    upsert(agent: AgentDefinition): void {
      // Validate before writing — better to fail fast than persist a file
      // that won't load back.
      const validated = AgentDefinitionSchema.parse(agent);
      assertNoGlobalCollisions(validated);
      const folder = agentFolder(agentsDir, validated.id);
      const filePath = path.join(folder, AGENT_FILE);
      const folderExistedBefore = fs.existsSync(folder);
      ensureDir(folder);
      ensureDir(path.join(folder, "workspace"));
      try {
        fs.writeFileSync(filePath, serializeAgent(validated), "utf-8");
      } catch (e) {
        // If serialization or write fails, don't leave a half-built folder
        // sitting around — list() would skip it (no AGENT.md), but it
        // confuses the operator and blocks a follow-up upsert from a clean
        // state. Only delete folders WE created in this call.
        if (!folderExistedBefore) {
          try {
            fs.rmSync(folder, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
        throw e;
      }
    },

    delete(id: string): void {
      if (!SAFE_ID.test(id)) return;
      const folder = agentFolder(agentsDir, id);
      if (fs.existsSync(folder)) {
        // rm -rf — the folder may contain sibling assets the user added
        // (custom prompts, attachments). Deleting the agent removes them.
        fs.rmSync(folder, { recursive: true, force: true });
      }
    },
  };
}
