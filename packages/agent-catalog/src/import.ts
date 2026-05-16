import {
  AgentDefinitionSchema,
  type AgentDefinition,
} from "@openacme/config";
import type { AgentTemplate } from "./types.js";

// Mirrors `SAFE_ID` in `@openacme/config/src/agent-store.ts`. The store
// uses the same regex on every upsert; we validate here so callers get
// a clean error before any side effect.
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface BuildOptions {
  /** Caller-supplied id. Validated and checked for uniqueness. */
  idOverride?: string;
  /** Caller-supplied display name. Display names need not be unique. */
  nameOverride?: string;
  /**
   * Partial AgentDefinition fields that overlay the template's values
   * before validation. Useful for the web import form where the user
   * tweaks `model` / `persona` / `tools` before committing.
   *
   * Cannot override `id` (use `idOverride`).
   */
  overrides?: Partial<Omit<AgentDefinition, "id">>;
}

export class TemplateImportError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_ID"
      | "ID_COLLISION"
      | "VALIDATION_FAILED"
  ) {
    super(message);
    this.name = "TemplateImportError";
  }
}

/**
 * Pure: builds a runtime `AgentDefinition` from a catalog template.
 * No filesystem side effects, no skill installs — just id resolution,
 * field merging, and schema validation. Callers (the import flow) handle
 * the side-effectful steps after this returns.
 */
export function buildAgentFromTemplate(
  template: AgentTemplate,
  opts: BuildOptions,
  existingIds: ReadonlySet<string>
): AgentDefinition {
  const id = resolveId(template, opts, existingIds);
  const name = opts.nameOverride?.trim() || template.agentFields.name;

  // Callers cannot forge `managed`. Only the template's own frontmatter
  // marks an agent as platform-managed.
  const overrides = { ...(opts.overrides ?? {}) };
  if ("managed" in overrides) delete (overrides as Record<string, unknown>).managed;

  const merged = {
    ...template.agentFields,
    ...overrides,
    id,
    name,
  };

  const parsed = AgentDefinitionSchema.safeParse(merged);
  if (!parsed.success) {
    throw new TemplateImportError(
      `Built AgentDefinition failed schema validation: ${parsed.error.message}`,
      "VALIDATION_FAILED"
    );
  }
  return parsed.data;
}

function resolveId(
  template: AgentTemplate,
  opts: BuildOptions,
  existingIds: ReadonlySet<string>
): string {
  if (opts.idOverride !== undefined) {
    const candidate = opts.idOverride.trim();
    if (!SAFE_AGENT_ID.test(candidate)) {
      throw new TemplateImportError(
        `Invalid agent id "${opts.idOverride}": must match ${SAFE_AGENT_ID.source}`,
        "INVALID_ID"
      );
    }
    if (existingIds.has(candidate)) {
      throw new TemplateImportError(
        `Agent id "${candidate}" already exists`,
        "ID_COLLISION"
      );
    }
    return candidate;
  }
  // Auto-increment off default_id_hint until free.
  const base = template.meta.defaultIdHint;
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) {
    n += 1;
    if (n > 10_000) {
      // Pathological case; bail rather than spin.
      throw new TemplateImportError(
        `Could not allocate a unique id from "${base}" after 10000 attempts`,
        "ID_COLLISION"
      );
    }
  }
  return `${base}-${n}`;
}
