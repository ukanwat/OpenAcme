import * as os from "node:os";
import { createLogger } from "@openacme/config/logger";

const log = createLogger("mcp-client.security");

/**
 * Environment variables that are safe to pass through to MCP stdio subprocesses.
 * Mirrors Hermes mcp_tool.py _SAFE_ENV_KEYS.
 */
const SAFE_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
]);

/**
 * Build a filtered environment dict for stdio subprocesses.
 * Only passes safe baseline vars + XDG + user-specified vars.
 */
export function buildSafeEnv(userEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && (SAFE_ENV_KEYS.has(key) || key.startsWith("XDG_"))) {
      env[key] = value;
    }
  }
  if (userEnv) {
    Object.assign(env, userEnv);
  }
  return env;
}

/**
 * Regex for credential patterns to strip from error messages.
 * Mirrors Hermes mcp_tool.py _CREDENTIAL_PATTERN.
 */
const CREDENTIAL_PATTERN = /(?:ghp_[A-Za-z0-9_]{1,255}|sk-[A-Za-z0-9_]{1,255}|Bearer\s+\S+|token=[^\s&,;"']{1,255}|key=[^\s&,;"']{1,255}|API_KEY=[^\s&,;"']{1,255}|password=[^\s&,;"']{1,255}|secret=[^\s&,;"']{1,255})/gi;

/**
 * Strip credential-like patterns from error text before returning to LLM.
 */
export function sanitizeError(text: string): string {
  return text.replace(CREDENTIAL_PATTERN, "[REDACTED]");
}

/**
 * Injection patterns to warn about in MCP tool descriptions.
 * Mirrors Hermes mcp_tool.py _MCP_INJECTION_PATTERNS.
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, reason: "prompt override" },
  { pattern: /you\s+are\s+now\s+a/i, reason: "identity override" },
  { pattern: /system\s*:\s*/i, reason: "system prompt injection" },
  { pattern: /<\s*(system|human|assistant)\s*>/i, reason: "role tag injection" },
  { pattern: /do\s+not\s+(tell|inform|mention|reveal)/i, reason: "concealment instruction" },
  { pattern: /(curl|wget|fetch)\s+https?:\/\//i, reason: "network command in description" },
  { pattern: /exec\s*\(|eval\s*\(/i, reason: "code execution reference" },
];

/**
 * Scan an MCP tool description for prompt injection patterns.
 * Returns warnings (empty = clean).
 */
export function scanDescription(
  serverName: string,
  toolName: string,
  description: string
): string[] {
  const findings: string[] = [];
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(description)) {
      findings.push(reason);
    }
  }
  if (findings.length > 0) {
    log.warn(
      { server: serverName, tool: toolName, findings },
      "suspicious MCP tool description"
    );
  }
  return findings;
}
