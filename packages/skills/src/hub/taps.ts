import * as fs from "node:fs";
import { z } from "zod";
import { TapsFileSchema, TapSchema } from "./schemas.js";
import { tapsFile } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import type { Tap, TapSource } from "./types.js";

type TapsFileShape = z.infer<typeof TapsFileSchema>;

const DEFAULT_TAPS: Tap[] = [
  {
    source: "github",
    repo: "anthropics/skills",
    path: "skills/",
    addedAt: "2026-01-01T00:00:00.000Z",
  },
];

function defaultPathFor(source: TapSource): string {
  return source === "github" ? "skills/" : "";
}

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
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8")) as {
      version?: unknown;
      taps?: unknown[];
    };
    // Legacy taps.json files (pre-discriminated-union) may have entries
    // without a recognized `source`. Coerce to "github" so the schema
    // doesn't reject the whole file.
    if (Array.isArray(raw.taps)) {
      raw.taps = raw.taps.map((t) => {
        if (t && typeof t === "object") {
          const obj = t as Record<string, unknown>;
          if (typeof obj["source"] !== "string") obj["source"] = "github";
        }
        return t;
      });
    }
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

  has(repo: string, source?: TapSource): boolean {
    return this.load().some(
      (t) => t.repo === repo && (!source || t.source === source)
    );
  }

  add(input: { source: TapSource; repo: string; path?: string }): Tap {
    const parsed = TapSchema.safeParse({
      source: input.source,
      repo: input.repo,
      path: input.path ?? defaultPathFor(input.source),
      addedAt: new Date().toISOString(),
    });
    if (!parsed.success) {
      // First issue is enough — Zod's default `.message` stringifies all
      // issues as JSON and looks awful in a toast.
      const first = parsed.error.issues[0];
      const where = first?.path.join(".") || "input";
      throw new Error(`${where}: ${first?.message ?? "invalid"}`);
    }
    const candidate = parsed.data;
    const taps = this.load();
    if (
      taps.some(
        (t) => t.source === candidate.source && t.repo === candidate.repo
      )
    ) {
      throw new Error(`tap already exists: ${candidate.source} ${candidate.repo}`);
    }
    taps.push(candidate);
    this.save();
    return candidate;
  }

  remove(repo: string, source?: TapSource): boolean {
    const taps = this.load();
    const idx = taps.findIndex(
      (t) => t.repo === repo && (!source || t.source === source)
    );
    if (idx === -1) return false;
    taps.splice(idx, 1);
    this.save();
    return true;
  }

  /** Filter taps by source for adapters that only consume their own kind. */
  forSource(source: TapSource): Tap[] {
    return this.load().filter((t) => t.source === source);
  }

  private save(): void {
    if (!this.cache) return;
    atomicWriteSync(this.filePath(), JSON.stringify(this.cache, null, 2));
  }
}
