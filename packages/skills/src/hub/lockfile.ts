import * as fs from "node:fs";
import { z } from "zod";
import { HubLockFileSchema } from "./schemas.js";
import { lockFile } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
import type { HubLockEntry } from "./types.js";

type HubLockFileShape = z.infer<typeof HubLockFileSchema>;

const EMPTY: HubLockFileShape = { version: 1, installed: {} };

export class HubLockFile {
  private cache: HubLockFileShape | null = null;

  constructor(private readonly skillsDir: string) {}

  private filePath(): string {
    return lockFile(this.skillsDir);
  }

  /** Load or return cached. Returns the empty shape if file is absent. */
  load(): HubLockFileShape {
    if (this.cache) return this.cache;
    const fp = this.filePath();
    if (!fs.existsSync(fp)) {
      this.cache = { ...EMPTY };
      return this.cache;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
      const parsed = HubLockFileSchema.safeParse(raw);
      if (!parsed.success) {
        // Corrupt or out-of-version file — refuse to silently lose data;
        // surface to caller so they can decide.
        throw new Error(`invalid lock.json: ${parsed.error.message}`);
      }
      this.cache = parsed.data;
      return this.cache;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`lock.json is not valid JSON: ${err.message}`);
      }
      throw err;
    }
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
    this.save();
  }

  remove(name: string): boolean {
    const data = this.load();
    if (!(name in data.installed)) return false;
    delete data.installed[name];
    this.save();
    return true;
  }

  private save(): void {
    if (!this.cache) return;
    atomicWriteSync(this.filePath(), JSON.stringify(this.cache, null, 2));
  }
}
