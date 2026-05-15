/**
 * Memory freshness wrapping — verbatim port of Claude Code `memdir/memoryAge.ts`.
 *
 * Stale-memory mitigation. When the agent reads an entry file via `view`,
 * a `<system-reminder>` is prepended if the file is more than one day old,
 * warning the model that the content is a point-in-time observation.
 *
 * Why human age strings instead of ISO timestamps (Claude Code's reasoning):
 * "Models are poor at date arithmetic — a raw ISO timestamp doesn't trigger
 * staleness reasoning the way '47 days ago' does."
 *
 * Why the wrapper exists at all: "Motivated by user reports of stale
 * code-state memories (file:line citations to code that has since changed)
 * being asserted as fact — the citation makes the stale claim sound more
 * authoritative, not less."
 */

const ONE_DAY_MS = 86_400_000;

/**
 * Days elapsed since mtime. Floor-rounded — 0 for today, 1 for yesterday,
 * 2+ for older. Negative inputs (future mtime, clock skew) clamp to 0.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / ONE_DAY_MS));
}

/**
 * Human-readable age string. Models are poor at date arithmetic — a raw
 * ISO timestamp doesn't trigger staleness reasoning the way "47 days ago"
 * does.
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

/**
 * Plain-text staleness caveat for memories >1 day old. Returns '' for
 * fresh (today/yesterday) memories — warning there is noise.
 *
 * Use this when the caller already provides its own wrapping (e.g.
 * recall blocks that wrap each memory in a single `<system-reminder>`).
 *
 * Verbatim port of Claude Code `memdir/memoryAge.ts:memoryFreshnessText`.
 */
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

/**
 * Per-memory staleness note wrapped in `<system-reminder>` tags.
 * Returns '' for memories ≤ 1 day old (warning there is noise).
 *
 * Use this on `view` results for entry files where the caller doesn't
 * supply its own wrapper. Recall blocks use `memoryFreshnessText`
 * instead (they wrap the whole block themselves).
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  if (!text) return "";
  return `<system-reminder>${text}</system-reminder>\n`;
}
