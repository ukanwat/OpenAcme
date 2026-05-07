import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import type { MCPServerConfig } from "@openacme/config";
import type { ToolRegistry } from "@openacme/tools";
import { buildSafeEnv, sanitizeError, scanDescription } from "./security.js";

// Timeout defaults in seconds (matching config schema units)
const DEFAULT_TOOL_TIMEOUT_SECONDS = 120;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 60;
const MAX_RECONNECT_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

interface ServerConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  name: string;
  toolNames: string[];
}

/**
 * MCPClient — connects to external MCP servers, discovers their tools,
 * and registers them into the agent's tool registry.
 *
 * Architecture mirrors Hermes mcp_tool.py:
 * - Stdio transport (subprocess) and HTTP/SSE transport
 * - Auto-reconnection with backoff
 * - Safe env filtering for subprocesses
 * - Credential stripping from error messages
 * - Description scanning for injection patterns
 */
export class MCPClient {
  private registry: ToolRegistry;
  private connections = new Map<string, ServerConnection>();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * Connect to all configured MCP servers and register their tools.
   * Implements exponential backoff retry for failed connections.
   */
  async connect(
    servers: Record<string, MCPServerConfig>
  ): Promise<{ connected: string[]; failed: string[] }> {
    const connected: string[] = [];
    const failed: string[] = [];

    for (const [name, config] of Object.entries(servers)) {
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_RECONNECT_RETRIES; attempt++) {
        try {
          await this.connectServer(name, config);
          connected.push(name);
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));

          if (attempt < MAX_RECONNECT_RETRIES) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(
              `MCP server '${name}' connection attempt ${attempt}/${MAX_RECONNECT_RETRIES} failed: ${sanitizeError(lastError.message)}. Retrying in ${delay}ms...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (lastError) {
        console.error(
          `MCP server '${name}' failed to connect after ${MAX_RECONNECT_RETRIES} attempts: ${sanitizeError(lastError.message)}`
        );
        failed.push(name);
      }
    }

    return { connected, failed };
  }

  /**
   * Connect to a single MCP server.
   */
  private async connectServer(
    name: string,
    config: MCPServerConfig
  ): Promise<void> {
    // Config values are in seconds, use seconds throughout
    const connectTimeoutSeconds = config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
    const toolTimeoutSeconds = config.timeout ?? DEFAULT_TOOL_TIMEOUT_SECONDS;

    let transport: StdioClientTransport | SSEClientTransport;

    if (config.command) {
      // Stdio transport — spawn subprocess
      const env = buildSafeEnv(config.env);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
      });
    } else if (config.url) {
      // HTTP/SSE transport
      transport = new SSEClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
      });
    } else {
      throw new Error(
        `MCP server '${name}': must specify either 'command' (stdio) or 'url' (HTTP)`
      );
    }

    const client = new Client(
      { name: `openacme-${name}`, version: "0.0.1" },
      { capabilities: {} }
    );

    // Connect with timeout
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection timeout after ${connectTimeoutSeconds}s`)),
        connectTimeoutSeconds * 1000
      )
    );

    await Promise.race([connectPromise, timeoutPromise]);

    // Discover tools
    const toolNames = await this.discoverTools(name, client, toolTimeoutSeconds);

    this.connections.set(name, {
      client,
      transport,
      name,
      toolNames,
    });

    console.log(
      `  ✓ MCP server '${name}' connected (${toolNames.length} tools)`
    );
  }

  /**
   * Discover tools from an MCP server and register them into the tool registry.
   */
  private async discoverTools(
    serverName: string,
    client: Client,
    toolTimeoutSeconds: number
  ): Promise<string[]> {
    const response = await client.listTools();
    const toolNames: string[] = [];

    for (const tool of response.tools) {
      // Sanitized tool name — prefix with server name to avoid collisions
      const registryName = `mcp_${serverName}__${tool.name}`;
      const toolset = `mcp-${serverName}`;

      // Scan description for injection
      scanDescription(serverName, tool.name, tool.description ?? "");

      // Build a Zod schema from the MCP tool's JSON Schema input schema
      const parameters = this.jsonSchemaToZod(tool.inputSchema).describe(
        tool.description ?? `MCP tool: ${tool.name}`
      );

      // Register into the agent's tool registry
      this.registry.register({
        name: registryName,
        toolset,
        description: tool.description ?? `Tool from MCP server '${serverName}'`,
        parameters,
        emoji: "🔌",
        parallelSafe: true,
        handler: async (args: Record<string, unknown>) => {
          return this.callTool(serverName, tool.name, args, toolTimeoutSeconds);
        },
      });

      toolNames.push(registryName);
    }

    return toolNames;
  }

  /**
   * Convert a JSON Schema to a basic Zod schema.
   * Handles common cases; falls back to z.record(z.unknown()) for complex schemas.
   */
  private jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
    if (!schema || typeof schema !== "object") {
      return z.record(z.unknown());
    }

    const s = schema as Record<string, unknown>;

    // Handle object type with properties
    if (s.type === "object" && s.properties && typeof s.properties === "object") {
      const props = s.properties as Record<string, Record<string, unknown>>;
      const required = new Set(Array.isArray(s.required) ? s.required : []);

      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(props)) {
        let propZod = this.jsonSchemaPrimitiveToZod(propSchema);
        if (propSchema.description && typeof propSchema.description === "string") {
          propZod = propZod.describe(propSchema.description);
        }
        if (!required.has(key)) {
          propZod = propZod.optional();
        }
        shape[key] = propZod;
      }
      return z.object(shape);
    }

    // Fallback for other schemas
    return z.record(z.unknown());
  }

  /**
   * Convert a JSON Schema primitive type to Zod.
   */
  private jsonSchemaPrimitiveToZod(schema: Record<string, unknown>): z.ZodTypeAny {
    switch (schema.type) {
      case "string":
        if (Array.isArray(schema.enum)) {
          return z.enum(schema.enum as [string, ...string[]]);
        }
        return z.string();
      case "number":
      case "integer":
        return z.number();
      case "boolean":
        return z.boolean();
      case "array":
        if (schema.items && typeof schema.items === "object") {
          return z.array(this.jsonSchemaPrimitiveToZod(schema.items as Record<string, unknown>));
        }
        return z.array(z.unknown());
      case "object":
        return this.jsonSchemaToZod(schema);
      default:
        return z.unknown();
    }
  }

  /**
   * Call a tool on an MCP server.
   */
  private async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutSeconds: number
  ): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return JSON.stringify({
        error: `MCP server '${serverName}' is not connected`,
      });
    }

    try {
      const callPromise = conn.client.callTool({
        name: toolName,
        arguments: args,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Tool call timeout after ${timeoutSeconds}s`)),
          timeoutSeconds * 1000
        )
      );

      const result = await Promise.race([callPromise, timeoutPromise]);

      // Extract text content from MCP result
      if (result.content && Array.isArray(result.content)) {
        const texts = result.content
          .filter(
            (c: { type: string }) => c.type === "text"
          )
          .map((c: { text: string }) => c.text);
        return texts.join("\n") || JSON.stringify(result);
      }

      return JSON.stringify(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ error: sanitizeError(msg) });
    }
  }

  /**
   * Disconnect all MCP servers and deregister their tools.
   */
  async disconnect(): Promise<void> {
    for (const [name, conn] of this.connections) {
      // Deregister tools
      for (const toolName of conn.toolNames) {
        this.registry.deregister(toolName);
      }

      // Close transport
      try {
        await conn.client.close();
      } catch {
        // Best effort
      }

      console.log(`  ✓ MCP server '${name}' disconnected`);
    }
    this.connections.clear();
  }

  /**
   * Get status of all connected servers.
   */
  getStatus(): Array<{
    name: string;
    connected: boolean;
    toolCount: number;
    tools: string[];
  }> {
    return [...this.connections.values()].map((conn) => ({
      name: conn.name,
      connected: true,
      toolCount: conn.toolNames.length,
      tools: conn.toolNames,
    }));
  }
}
