export {
  MemoryStore,
  DEFAULT_MEMORY_CHAR_LIMIT,
  type IndexSnapshot,
} from "./store.js";

export {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessNote,
  memoryFreshnessText,
} from "./freshness.js";

export {
  scanMemoryFiles,
  formatMemoryManifest,
  parseFrontmatterDescription,
  type MemoryHeader,
} from "./scan.js";

export { scanMemoryContent, type ScanResult } from "./threat-scanner.js";

export { MEMORY_THREAT_PATTERNS, INVISIBLE_CHARS } from "./threat-patterns.js";
