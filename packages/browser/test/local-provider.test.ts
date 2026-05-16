import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalChromeProvider } from "../src/providers/local.js";
import { resolveUserDataDir } from "../src/chrome.js";
import type { BrowserConfig } from "../src/types.js";

const BASE_CFG: BrowserConfig = {
  enabled: true,
  provider: "local",
  localBrowser: "chromium",
  headless: true,
  noSandbox: false,
};

describe("resolveUserDataDir", () => {
  it("places each agent under its own browser-profile dir", () => {
    const a = resolveUserDataDir("/tmp/foo", "agent-1");
    const b = resolveUserDataDir("/tmp/foo", "agent-2");
    expect(a).toBe(path.join("/tmp/foo", "agents", "agent-1", "browser-profile"));
    expect(b).toBe(path.join("/tmp/foo", "agents", "agent-2", "browser-profile"));
    expect(a).not.toBe(b);
  });

  it("rejects an empty agentId", () => {
    expect(() => resolveUserDataDir("/tmp/foo", "")).toThrow(/agentId/i);
  });
});

describe("LocalChromeProvider", () => {
  let tmpDir: string;
  let provider: LocalChromeProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-browser-test-"));
    provider = new LocalChromeProvider({ dataDir: tmpDir, config: BASE_CFG });
  });

  afterEach(async () => {
    await provider.releaseAll().catch(() => {});
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("reports name 'local'", () => {
    expect(provider.name).toBe("local");
  });

  it("acquire rejects empty agentId", async () => {
    await expect(provider.acquire("")).rejects.toThrow(/agentId/i);
  });

  it("rejects an executablePath override pointing at a missing file", async () => {
    const noChromeCfg: BrowserConfig = { ...BASE_CFG, executablePath: "/nonexistent/binary-zzz" };
    const p = new LocalChromeProvider({ dataDir: tmpDir, config: noChromeCfg });
    // isConfigured always returns true post-refactor (chromium auto-install
    // path means we can always resolve *something*); the override-existence
    // check fires at acquire time instead.
    await expect(p.acquire("agent-x")).rejects.toThrow(/executablePath.*does not exist/i);
  });

  it("releaseAgent is idempotent on an unknown id", async () => {
    await expect(provider.releaseAgent("never-acquired")).resolves.toBeUndefined();
    await expect(provider.releaseAgent("never-acquired")).resolves.toBeUndefined();
  });

  it("releaseAll is idempotent when no sessions are held", async () => {
    await expect(provider.releaseAll()).resolves.toBeUndefined();
    await expect(provider.releaseAll()).resolves.toBeUndefined();
  });
});
