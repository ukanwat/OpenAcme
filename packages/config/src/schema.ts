import { z } from "zod";

/**
 * Supported LLM provider identifiers.
 */
export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "ollama",
  "custom",
]);
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * Authentication mode for a model: API key (default) or OAuth subscription.
 * OAuth tokens live in `~/.openacme/auth.json` — see `@openacme/auth`.
 */
export const AuthModeSchema = z.enum(["api_key", "oauth"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

/**
 * Model configuration — which provider and model to use.
 */
export const ModelConfigSchema = z.object({
  provider: ProviderSchema.default("openrouter"),
  model: z.string().default("anthropic/claude-sonnet-4-20250514"),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  auth: AuthModeSchema.default("api_key"),
  headers: z.record(z.string()).optional(),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * MCP server configuration — how to connect to an external MCP server.
 */
export const MCPServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  timeout: z.number().default(120),
  connectTimeout: z.number().default(60),
  allowedTools: z.array(z.string()).optional(),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

/**
 * Agent definition — a named agent with its own config.
 */
export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: ModelConfigSchema.default({}),
  persona: z.string().default("You are a helpful AI assistant."),
  tools: z
    .array(z.string())
    .default([
      "shell",
      "read_file",
      "write_file",
      "edit",
      "apply_patch",
      "list_files",
      "search_files",
      "session_search",
      "web_search",
      "web_extract",
    ]),
  mcpServers: z.record(MCPServerConfigSchema).default({}),
  skills: z.array(z.string()).default([]),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

/**
 * Server configuration.
 */
export const ServerConfigSchema = z.object({
  port: z.number().default(3210),
  host: z.string().default("127.0.0.1"),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Agent behavior configuration.
 */
export const AgentBehaviorSchema = z.object({
  maxSteps: z.number().default(10),
  maxIterations: z.number().default(90),
});
export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

/**
 * Skills configuration.
 */
export const SkillsConfigSchema = z.object({
  directory: z.string().default("skills"),
  autoGenerate: z.boolean().default(false),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

/**
 * Web tools configuration — search provider + key resolution.
 * If `searchApiKey` is unset the agent reads from env vars at call-time
 * (OPENACME_SEARCH_API_KEY, then TAVILY_API_KEY / EXA_API_KEY / BRAVE_API_KEY).
 */
export const WebConfigSchema = z.object({
  searchProvider: z.enum(["tavily", "exa", "brave"]).default("tavily"),
  searchApiKey: z.string().optional(),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

/**
 * Root configuration schema — maps to config.yaml
 *
 * Agents are not stored here. They live as folders under
 * `<dataDir>/agents/<id>/AGENT.md`, one folder per agent. Any `agents:`
 * key in older configs is silently ignored by Zod's default object stripping.
 */
export const ConfigSchema = z.object({
  dataDir: z.string().default("~/.openacme"),
  model: ModelConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  behavior: AgentBehaviorSchema.default({}),
  skills: SkillsConfigSchema.default({}),
  web: WebConfigSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
