/**
 * Threat-pattern data for the memory scanner. Ported verbatim from Hermes
 * `tools/memory_tool.py:67-89`. Kept in its own file (no logic) so the
 * pattern set is easy to audit and update independently of the scanner.
 *
 * `re.IGNORECASE` becomes the JS `i` flag; the regex syntax itself is
 * identical (no Python-only features in these patterns).
 */

export const MEMORY_THREAT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Prompt injection
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [
    /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i,
    "bypass_restrictions",
  ],
  // Exfiltration via curl/wget with secrets
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  // Persistence via shell rc / ssh
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
  [/\$HOME\/\.openacme\/\.env|~\/\.openacme\/\.env/i, "openacme_env"],
];

export const INVISIBLE_CHARS: ReadonlySet<string> = new Set<string>([
  "​",
  "‌",
  "‍",
  "⁠",
  "﻿",
  "‪",
  "‫",
  "‬",
  "‭",
  "‮",
]);
