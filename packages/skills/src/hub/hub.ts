import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import matter from "gray-matter";
import { SkillRegistry } from "../registry.js";
import { HubLockFile } from "./lockfile.js";
import { TapsManager } from "./taps.js";
import { appendAuditLog, readAuditLog } from "./audit.js";
import { IndexCache } from "./index-cache.js";
import { GitHubAuth } from "./github-auth.js";
import { GitHubSource } from "./sources/github.js";
import { UrlSource } from "./sources/url.js";
import { ClaudeMarketplaceSource } from "./sources/claude-marketplace.js";
import {
  hubDir,
  skillTargetDir,
  stagingDir,
} from "./paths.js";
import {
  InvalidBundlePathError,
  validateBundlePath,
  validateSkillName,
  safeName as sanitizeSkillName,
} from "./path-validation.js";
import type {
  AuditAction,
  AuditRow,
  HubLockEntry,
  SkillBundle,
  SkillMeta,
  SkillSource,
  SkillSourceId,
  TrustLevel,
} from "./types.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

export class HubError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "HubError";
  }
}

export interface InstallResult {
  name: string;
  contentHash: string;
  lockEntry: HubLockEntry;
}

export interface InstallOptions {
  source?: SkillSourceId;
  nameOverride?: string;
  force?: boolean;
  signal?: AbortSignal;
}

export interface SearchOptions {
  source?: "all" | SkillSourceId;
  limit?: number;
  signal?: AbortSignal;
}

export class SkillHub {
  readonly lockfile: HubLockFile;
  readonly taps: TapsManager;
  readonly cache: IndexCache;
  readonly auth: GitHubAuth;
  private readonly github: GitHubSource;
  private readonly url: UrlSource;
  private readonly marketplace: ClaudeMarketplaceSource;

  constructor(
    private readonly skillsDir: string,
    private readonly registry: SkillRegistry
  ) {
    this.lockfile = new HubLockFile(skillsDir);
    this.taps = new TapsManager(skillsDir);
    this.cache = new IndexCache(skillsDir);
    this.auth = new GitHubAuth();
    this.github = new GitHubSource(this.auth, this.cache, () => this.taps.list());
    this.url = new UrlSource();
    this.marketplace = new ClaudeMarketplaceSource(
      this.github,
      this.auth,
      this.cache,
      () => this.taps.list()
    );
  }

  // ---------------- Public surface ----------------

  async search(query: string, opts: SearchOptions = {}): Promise<SkillMeta[]> {
    const sources = this.pickSources(opts.source);
    const limit = opts.limit ?? 25;
    const seen = new Set<string>();
    const results: SkillMeta[] = [];

    const parts = await Promise.all(
      sources.map((src) =>
        src.search(query, { limit, signal: opts.signal }).catch((err) => {
          console.warn(
            `SkillHub.search: ${src.id} failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return [] as SkillMeta[];
        })
      )
    );

    for (const part of parts) {
      for (const m of part) {
        if (results.length >= limit) return results;
        const key = `${m.source}:${m.identifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(m);
      }
    }
    return results;
  }

  async inspect(
    identifier: string,
    opts: { source?: SkillSourceId; signal?: AbortSignal } = {}
  ): Promise<SkillMeta | null> {
    const source = await this.resolveSource(identifier, opts.source, opts.signal);
    if (!source) return null;
    return source.inspect(identifier, { signal: opts.signal });
  }

  async install(
    identifier: string,
    opts: InstallOptions = {}
  ): Promise<InstallResult> {
    const source = await this.resolveSource(identifier, opts.source, opts.signal);
    if (!source) {
      throw new HubError(
        `no source could resolve identifier: ${identifier}`,
        "NO_SOURCE"
      );
    }

    let bundle: SkillBundle | null;
    try {
      bundle = await source.fetch(identifier, { signal: opts.signal });
    } catch (err) {
      this.audit("INSTALL_FAILED", {
        source: source.id,
        identifier,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw new HubError(
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "FETCH_FAILED"
      );
    }
    if (!bundle) {
      this.audit("INSTALL_FAILED", {
        source: source.id,
        identifier,
        outcome: "error",
        reason: "source returned no bundle",
      });
      throw new HubError(`source returned no bundle for: ${identifier}`, "EMPTY_BUNDLE");
    }

    // Validate bundle shape.
    this.validateBundle(bundle);

    // Resolve canonical name.
    const rawName = opts.nameOverride ?? bundle.name;
    const candidateName = sanitizeSkillName(rawName);
    validateSkillName(candidateName);

    const skillMd = bundle.files.find((f) => f.relPath === "SKILL.md")!;
    const { data: fmRaw } = matter(new TextDecoder().decode(skillMd.bytes));
    const fm = fmRaw as Record<string, unknown>;
    const fmStr = (k: string): string | undefined =>
      typeof fm[k] === "string" ? (fm[k] as string) : undefined;

    const fmNameRaw = fmStr("name");
    const fmName = fmNameRaw ? sanitizeSkillName(fmNameRaw) : null;
    if (fmName && !opts.nameOverride && fmName !== candidateName) {
      this.audit("INSTALL_FAILED", {
        source: source.id,
        identifier,
        outcome: "error",
        reason: `bundle name ${candidateName} doesn't match frontmatter ${fmName}`,
      });
      throw new HubError(
        `bundle name '${candidateName}' doesn't match SKILL.md frontmatter name '${fmName}'`,
        "NAME_MISMATCH"
      );
    }

    // Lockfile collision.
    const existing = this.lockfile.get(candidateName);
    if (existing && !opts.force) {
      throw new HubError(
        `skill '${candidateName}' is already installed (use force to overwrite)`,
        "ALREADY_INSTALLED"
      );
    }

    // Atomic write: stage → rename.
    const target = skillTargetDir(this.skillsDir, candidateName);
    const stagingRoot = stagingDir(this.skillsDir);
    fs.mkdirSync(stagingRoot, { recursive: true });
    const staging = path.join(
      stagingRoot,
      `${candidateName}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`
    );
    fs.mkdirSync(staging, { recursive: true });

    try {
      for (const f of bundle.files) {
        // Defense in depth — already validated, but resolve and check
        // before any write.
        validateBundlePath(f.relPath);
        const dest = path.join(staging, f.relPath);
        const destReal = path.resolve(dest);
        if (
          !destReal.startsWith(path.resolve(staging) + path.sep) &&
          destReal !== path.resolve(staging)
        ) {
          throw new InvalidBundlePathError(`path escapes staging: ${f.relPath}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.bytes));
      }

      // If forcing over an existing install, remove the live dir first.
      if (fs.existsSync(target)) {
        if (!opts.force) {
          // Shouldn't happen — caught above, but guard anyway.
          throw new HubError(
            `target exists: ${candidateName}`,
            "ALREADY_INSTALLED"
          );
        }
        fs.rmSync(target, { recursive: true, force: true });
      }
      fs.renameSync(staging, target);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      // Best-effort cleanup of half-written target.
      if (fs.existsSync(target)) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch {
          // surface the original error
        }
      }
      this.audit("INSTALL_FAILED", {
        name: candidateName,
        source: source.id,
        identifier,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const now = new Date().toISOString();
    const entry: HubLockEntry = {
      version: fmStr("version"),
      contentHash: bundle.contentHash,
      source: bundle.source,
      identifier: bundle.sourceIdentifier,
      resolvedRef: bundle.resolvedRef || undefined,
      trustLevel: source.trustLevelFor(identifier),
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      files: bundle.files.map((f) => f.relPath),
    };
    this.lockfile.record(candidateName, entry);
    this.audit("INSTALL", {
      name: candidateName,
      source: bundle.source,
      identifier: bundle.sourceIdentifier,
      trustLevel: entry.trustLevel,
      contentHash: bundle.contentHash,
      outcome: "ok",
    });
    this.registry.loadFromDirectory(this.skillsDir);

    return { name: candidateName, contentHash: bundle.contentHash, lockEntry: entry };
  }

  async update(
    name: string | undefined,
    opts: { signal?: AbortSignal } = {}
  ): Promise<{ updated: string[]; unchanged: string[]; failed: Array<{ name: string; reason: string }> }> {
    const targets = name ? [name] : this.lockfile.list().map((e) => e.name);
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    // Diff-check upstream in parallel — these are read-only HTTPS fetches.
    // The install() step that follows mutates disk + lockfile and stays
    // serialized so two updates can't race on the same target.
    const checks = await Promise.all(
      targets.map(async (n) => {
        const entry = this.lockfile.get(n);
        if (!entry) {
          return { n, kind: "missing" as const };
        }
        try {
          const source = this.sourceById(entry.source);
          const bundle = await source.fetch(entry.identifier, { signal: opts.signal });
          if (!bundle) return { n, kind: "empty" as const, entry };
          return { n, kind: "fetched" as const, entry, bundle };
        } catch (err) {
          return {
            n,
            kind: "error" as const,
            entry,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    for (const r of checks) {
      if (r.kind === "missing") {
        failed.push({ name: r.n, reason: "not installed via hub" });
        continue;
      }
      if (r.kind === "empty") {
        failed.push({ name: r.n, reason: "fetch returned empty" });
        continue;
      }
      if (r.kind === "error") {
        this.audit("UPDATE_FAILED", {
          name: r.n,
          source: r.entry.source,
          identifier: r.entry.identifier,
          outcome: "error",
          reason: r.reason,
        });
        failed.push({ name: r.n, reason: r.reason });
        continue;
      }
      if (r.bundle.contentHash === r.entry.contentHash) {
        unchanged.push(r.n);
        continue;
      }
      try {
        await this.install(r.entry.identifier, {
          source: r.entry.source,
          force: true,
          signal: opts.signal,
        });
        this.audit("UPDATE", {
          name: r.n,
          source: r.entry.source,
          identifier: r.entry.identifier,
          oldHash: r.entry.contentHash,
          newHash: r.bundle.contentHash,
          outcome: "ok",
        });
        updated.push(r.n);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.audit("UPDATE_FAILED", {
          name: r.n,
          source: r.entry.source,
          identifier: r.entry.identifier,
          outcome: "error",
          reason,
        });
        failed.push({ name: r.n, reason });
      }
    }
    return { updated, unchanged, failed };
  }

  uninstall(name: string): boolean {
    const entry = this.lockfile.get(name);
    if (!entry) return false;
    const target = skillTargetDir(this.skillsDir, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    this.lockfile.remove(name);
    this.audit("UNINSTALL", {
      name,
      source: entry.source,
      identifier: entry.identifier,
      outcome: "ok",
    });
    this.registry.loadFromDirectory(this.skillsDir);
    return true;
  }

  listInstalled(): Array<HubLockEntry & { name: string }> {
    return this.lockfile.list();
  }

  audit(action: AuditAction, row: Omit<AuditRow, "ts" | "action">): void {
    appendAuditLog(this.skillsDir, { action, ...row });
  }

  readAudit(opts: { limit?: number; action?: AuditAction } = {}): AuditRow[] {
    return readAuditLog(this.skillsDir, opts);
  }

  // Taps wrappers (audit on add/remove).
  addTap(input: { source: "github" | "claude-marketplace"; repo: string; path?: string }) {
    const t = this.taps.add(input);
    this.audit("TAP_ADD", { repo: t.repo, outcome: "ok" });
    // Adding a tap can affect search/inspect — invalidate cache so the
    // new repo's tree is fetched fresh.
    this.invalidateIndexCache();
    return t;
  }

  removeTap(repo: string): boolean {
    const ok = this.taps.remove(repo);
    if (ok) {
      this.audit("TAP_REMOVE", { repo, outcome: "ok" });
      this.invalidateIndexCache();
    }
    return ok;
  }

  listTaps() {
    return this.taps.list();
  }

  // ---------------- Internals ----------------

  private pickSources(filter?: "all" | SkillSourceId): SkillSource[] {
    if (!filter || filter === "all") {
      return [this.github, this.marketplace, this.url];
    }
    return [this.sourceById(filter)];
  }

  private sourceById(id: SkillSourceId): SkillSource {
    if (id === "github") return this.github;
    if (id === "url") return this.url;
    return this.marketplace;
  }

  private async resolveSource(
    identifier: string,
    explicit?: SkillSourceId,
    signal?: AbortSignal
  ): Promise<SkillSource | null> {
    if (explicit) return this.sourceById(explicit);
    if (/^https?:\/\//i.test(identifier)) return this.url;
    // owner/repo[/path] heuristic: try GitHub first; fall back to marketplace.
    if (identifier.includes("/")) {
      const m = await this.github.inspect(identifier, { signal });
      if (m) return this.github;
      const m2 = await this.marketplace.inspect(identifier, { signal });
      if (m2) return this.marketplace;
    }
    return null;
  }

  private validateBundle(bundle: SkillBundle): void {
    if (bundle.files.length === 0) {
      throw new HubError("bundle is empty", "EMPTY_BUNDLE");
    }
    if (bundle.files.length > MAX_FILES) {
      throw new HubError(
        `bundle has too many files (${bundle.files.length} > ${MAX_FILES})`,
        "TOO_MANY_FILES"
      );
    }
    let total = 0;
    for (const f of bundle.files) {
      validateBundlePath(f.relPath);
      total += f.bytes.length;
    }
    if (total > MAX_TOTAL_BYTES) {
      throw new HubError(
        `bundle exceeds ${MAX_TOTAL_BYTES} bytes (got ${total})`,
        "TOO_LARGE"
      );
    }
    if (!bundle.files.some((f) => f.relPath === "SKILL.md")) {
      throw new HubError("bundle missing SKILL.md at root", "NO_SKILL_MD");
    }
  }

  private invalidateIndexCache(): void {
    const dir = path.join(hubDir(this.skillsDir), "index-cache");
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // For TrustLevel computation outside the hub.
  trustLevelFor(source: SkillSourceId, identifier: string): TrustLevel {
    return this.sourceById(source).trustLevelFor(identifier);
  }
}
