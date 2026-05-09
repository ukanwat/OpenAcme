/**
 * Memory content threat scanner.
 *
 * Memory entries get injected into the system prompt verbatim, so they're
 * a privileged channel — anything that would prompt-inject the agent or
 * exfiltrate secrets must be blocked at the gate. Scanner is a pure
 * function over the pattern set in `./threat-patterns.ts`.
 */

import { INVISIBLE_CHARS, MEMORY_THREAT_PATTERNS } from "./threat-patterns.js";

export type ScanResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Scan content destined for MEMORY.md. Returns `{ok:true}` if safe;
 * otherwise an error string in the same format Hermes uses (so error
 * wording stays consistent between ports).
 */
export function scanMemoryContent(content: string): ScanResult {
  for (const ch of content) {
    if (INVISIBLE_CHARS.has(ch)) {
      const codepoint = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
      return {
        ok: false,
        reason: `Blocked: content contains invisible unicode character U+${codepoint} (possible injection).`,
      };
    }
  }

  for (const [pattern, id] of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return {
        ok: false,
        reason: `Blocked: content matches threat pattern '${id}'. Memory entries are injected into the system prompt and must not contain injection or exfiltration payloads.`,
      };
    }
  }

  return { ok: true };
}
