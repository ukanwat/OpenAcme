import * as fs from "node:fs";
import { z } from "zod";
import { TapsFileSchema, TapSchema } from "./schemas.js";
import { tapsFile } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import type { Tap } from "./types.js";

type TapsFileShape = z.infer<typeof TapsFileSchema>;

const DEFAULT_TAPS: Tap[] = [
  {
    source: "github",
    repo: "anthropics/skills",
    path: "skills/",
    addedAt: "2026-01-01T00:00:00.000Z",
  },
];

export class TapsManager {
  private cache: TapsFileShape | null = null;

  constructor(private readonly skillsDir: string) {}

  private filePath(): string {
    return tapsFile(this.skillsDir);
  }

  /** Loads from disk, or returns defaults (anthropics/skills) if absent. */
  load(): Tap[] {
    if (this.cache) return this.cache.taps;
    const fp = this.filePath();
    if (!fs.existsSync(fp)) {
      this.cache = { version: 1, taps: [...DEFAULT_TAPS] };
      return this.cache.taps;
    }
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
    const parsed = TapsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid taps.json: ${parsed.error.message}`);
    }
    this.cache = parsed.data;
    return this.cache.taps;
  }

  list(): Tap[] {
    return this.load();
  }

  has(repo: string): boolean {
    return this.load().some((t) => t.repo === repo);
  }

  add(input: { source: Tap["source"]; repo: string; path?: string }): Tap {
    // Validate via TapSchema so input shape matches what we persist.
    const candidate = TapSchema.parse({
      source: input.source,
      repo: input.repo,
      path: input.path ?? "skills/",
      addedAt: new Date().toISOString(),
    });
    const taps = this.load();
    if (taps.some((t) => t.repo === candidate.repo && t.source === candidate.source)) {
      throw new Error(`tap already exists: ${candidate.source} ${candidate.repo}`);
    }
    taps.push(candidate);
    this.save();
    return candidate;
  }

  remove(repo: string): boolean {
    const taps = this.load();
    const idx = taps.findIndex((t) => t.repo === repo);
    if (idx === -1) return false;
    taps.splice(idx, 1);
    this.save();
    return true;
  }

  /** Filter taps by source for adapters that only consume their own kind. */
  forSource(source: Tap["source"]): Tap[] {
    return this.load().filter((t) => t.source === source);
  }

  private save(): void {
    if (!this.cache) return;
    atomicWriteSync(this.filePath(), JSON.stringify(this.cache, null, 2));
  }
}
