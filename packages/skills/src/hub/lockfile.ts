import * as fs from "node:fs";
import { z } from "zod";
import { HubLockFileSchema } from "./schemas.js";
import { lockFile } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import type { HubLockEntry } from "./types.js";

type HubLockFileShape = z.infer<typeof HubLockFileSchema>;

function empty(): HubLockFileShape {
  return { version: 1, installed: {} };
}

export class HubLockFile {
  constructor(private readonly skillsDir: string) {}

  private filePath(): string {
    return lockFile(this.skillsDir);
  }

  /**
   * Read from disk every call — no in-memory cache. Multiple SkillHub
   * instances (daemon route + CLI subcommand + legacy DELETE fallback)
   * all touch the same lock.json, and a cache would let them diverge.
   * The file is tiny, atomic temp+rename keeps reads consistent.
   *
   * The "missing file" path returns a fresh literal each call. Returning
   * `{ ...SHARED }` would shallow-copy and share `installed: {}` — a
   * later `record()` would mutate the shared map, poisoning every other
   * HubLockFile instance pointing at a missing file (e.g. test fixtures).
   */
  load(): HubLockFileShape {
    const fp = this.filePath();
    if (!fs.existsSync(fp)) return empty();
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`lock.json is not valid JSON: ${err.message}`);
      }
      throw err;
    }
    const parsed = HubLockFileSchema.safeParse(raw);
    if (!parsed.success) {
      // Corrupt or out-of-version — surface rather than silently lose data.
      throw new Error(`invalid lock.json: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  list(): Array<HubLockEntry & { name: string }> {
    const data = this.load();
    return Object.entries(data.installed).map(([name, entry]) => ({
      name,
      ...entry,
    }));
  }

  get(name: string): HubLockEntry | undefined {
    return this.load().installed[name];
  }

  record(name: string, entry: HubLockEntry): void {
    const data = this.load();
    data.installed[name] = entry;
    this.save(data);
  }

  remove(name: string): boolean {
    const data = this.load();
    if (!(name in data.installed)) return false;
    delete data.installed[name];
    this.save(data);
    return true;
  }

  private save(data: HubLockFileShape): void {
    atomicWriteSync(this.filePath(), JSON.stringify(data, null, 2));
  }
}
