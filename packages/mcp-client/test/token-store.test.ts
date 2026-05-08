import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileMCPTokenStore, InMemoryMCPTokenStore } from "../src/token-store.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openacme-mcp-tokens-"));
}

describe("FileMCPTokenStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for unknown server", async () => {
    const s = new FileMCPTokenStore(dir);
    expect(await s.getTokens("nope")).toBeUndefined();
    expect(await s.getClientInfo("nope")).toBeUndefined();
    expect(await s.getCodeVerifier("nope")).toBeUndefined();
  });

  it("round-trips tokens, client info, and verifier independently", async () => {
    const s = new FileMCPTokenStore(dir);
    await s.saveTokens("a", { access_token: "tk", token_type: "Bearer" });
    await s.saveCodeVerifier("a", "abc");
    expect((await s.getTokens("a"))?.access_token).toBe("tk");
    expect(await s.getCodeVerifier("a")).toBe("abc");
    // Saving one field doesn't clobber the other.
    await s.saveTokens("a", { access_token: "tk2", token_type: "Bearer" });
    expect(await s.getCodeVerifier("a")).toBe("abc");
  });

  it("deleteTokens leaves verifier intact", async () => {
    const s = new FileMCPTokenStore(dir);
    await s.saveTokens("a", { access_token: "tk", token_type: "Bearer" });
    await s.saveCodeVerifier("a", "verif");
    await s.deleteTokens("a");
    expect(await s.getTokens("a")).toBeUndefined();
    expect(await s.getCodeVerifier("a")).toBe("verif");
  });

  it("rejects unsafe server names", async () => {
    const s = new FileMCPTokenStore(dir);
    await expect(s.saveTokens("../escape", { access_token: "x", token_type: "Bearer" }))
      .rejects.toThrow(/Invalid MCP server name/);
    await expect(s.saveTokens(".hidden", { access_token: "x", token_type: "Bearer" }))
      .rejects.toThrow(/Invalid MCP server name/);
  });

  it("writes the token file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const s = new FileMCPTokenStore(dir);
    await s.saveTokens("a", { access_token: "tk", token_type: "Bearer" });
    const stat = fs.statSync(path.join(dir, "a.json"));
    // 0o600 = 0o0600 (owner rw only). Mask off file type bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("InMemoryMCPTokenStore", () => {
  it("works as a drop-in for tests", async () => {
    const s = new InMemoryMCPTokenStore();
    await s.saveTokens("a", { access_token: "tk", token_type: "Bearer" });
    await s.saveCodeVerifier("a", "v");
    expect((await s.getTokens("a"))?.access_token).toBe("tk");
    expect(await s.getCodeVerifier("a")).toBe("v");
    await s.deleteTokens("a");
    expect(await s.getTokens("a")).toBeUndefined();
    // verifier preserved
    expect(await s.getCodeVerifier("a")).toBe("v");
  });
});
