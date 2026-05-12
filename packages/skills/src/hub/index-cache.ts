import * as fs from "node:fs";
import * as path from "node:path";
import { indexCacheDir } from "./paths.js";
import { sha256Key } from "./content-hash.js";
import { atomicWriteSync } from "./atomic-write.js";

const TTL_SECONDS = 60 * 60;

interface CacheRecord {
  fetchedAt: number;
  data: unknown;
}

/**
 * On-disk TTL'd cache for remote-index calls (GitHub tree listings,
 * marketplace.json fetches).
 */
export class IndexCache {
  constructor(
    private readonly skillsDir: string,
    private readonly ttlSeconds = TTL_SECONDS
  ) {}

  private filePath(key: string): string {
    return path.join(indexCacheDir(this.skillsDir), `${sha256Key(key)}.json`);
  }

  read<T>(key: string): T | null {
    const fp = this.filePath(key);
    if (!fs.existsSync(fp)) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(fp, "utf-8")) as CacheRecord;
      const ageSec = Date.now() / 1000 - rec.fetchedAt;
      if (ageSec > this.ttlSeconds) return null;
      return rec.data as T;
    } catch {
      return null;
    }
  }

  write(key: string, data: unknown): void {
    const rec: CacheRecord = { fetchedAt: Math.floor(Date.now() / 1000), data };
    atomicWriteSync(this.filePath(key), JSON.stringify(rec));
  }
}
