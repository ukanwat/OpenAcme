/**
 * Stale-memory mitigation. CC `memdir/memoryAge.ts` lift. Human age
 * strings (not ISO) because models are poor at date arithmetic — "47
 * days ago" triggers staleness reasoning that a raw timestamp doesn't.
 */

const ONE_DAY_MS = 86_400_000;

/** Floor-rounded days since mtime. Future mtimes clamp to 0. */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / ONE_DAY_MS));
}

export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/** Plain-text caveat for entries >1 day old. Recall blocks use this
 *  inside their own wrapper; standalone callers want `memoryFreshnessNote`. */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return "";
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  );
}

/** Wrapped variant for `view` of standalone entry files. */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  if (!text) return "";
  return `<system-reminder>${text}</system-reminder>\n`;
}
