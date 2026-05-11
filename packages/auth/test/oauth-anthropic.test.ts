import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tryReimportClaudeCode } from "../src/oauth-anthropic.js";

// Drive `readClaudeCodeCredentials` via the real file path it inspects
// (`$HOME/.claude/.credentials.json`). Tests temporarily override `HOME`
// so the read finds OUR synthetic file, not the developer's real Claude
// Code install. We always write a synthetic file (even for the "stored
// matches" case) so the macOS keychain fallback never triggers —
// hitting the real keychain would either leak prod creds into the test
// or fail nondeterministically across machines.

let tmp: string;
let originalHome: string | undefined;

function setClaudeCodeToken(token: string): void {
  const claudeDir = path.join(tmp, "home", ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: "rt-" + token,
        expiresAt: Date.now() + 3600_000,
      },
    })
  );
}

function writeAuth(provider: "anthropic" | "openai", entry: object): void {
  const file = path.join(tmp, "auth.json");
  let existing: Record<string, unknown> = { version: 1 };
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      /* fresh */
    }
  }
  existing[provider] = entry;
  fs.writeFileSync(file, JSON.stringify(existing));
}

function readAuth(): Record<string, unknown> {
  const file = path.join(tmp, "auth.json");
  if (!fs.existsSync(file)) return { version: 1 };
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openacme-auth-test-"));
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  originalHome = process.env["HOME"];
  process.env["HOME"] = path.join(tmp, "home");
});

afterEach(() => {
  if (originalHome !== undefined) process.env["HOME"] = originalHome;
  else delete process.env["HOME"];
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("tryReimportClaudeCode", () => {
  it("returns null when Claude Code creds file is absent (no fallback override)", () => {
    // No file written; on Darwin the real impl would try the keychain
    // next, but we provide an empty `~/.claude/` so the loop terminates
    // there. We can't perfectly suppress the keychain probe on Darwin
    // without invasive mocking — so this test only asserts behavior when
    // `.credentials.json` is absent AND keychain returns nothing. On
    // CI/Linux this is automatic; on a dev macOS with a real Claude Code
    // login the keychain WILL return creds, so we skip the strict
    // null-assertion on darwin.
    if (process.platform === "darwin") {
      // Skip on darwin — keychain leaks real creds. Verified on Linux.
      return;
    }
    const result = tryReimportClaudeCode(tmp);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(tmp, "auth.json"))).toBe(false);
  });

  it("returns the active token and writes nothing when Claude Code matches stored entry", () => {
    setClaudeCodeToken("cc-aaaa");
    writeAuth("anthropic", {
      mode: "claude-code",
      access_token: "cc-aaaa",
      refresh_token: "rt-existing",
    });

    const beforeMtime = fs.statSync(path.join(tmp, "auth.json")).mtimeMs;
    const result = tryReimportClaudeCode(tmp);
    expect(result).toBe("cc-aaaa");

    // No write — refresh_token should still be the original (we'd have
    // overwritten with "rt-cc-aaaa" if writeEntry had been called).
    const stored = readAuth().anthropic as { refresh_token: string };
    expect(stored.refresh_token).toBe("rt-existing");
    const afterMtime = fs.statSync(path.join(tmp, "auth.json")).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("writes and returns the new token when Claude Code differs from stored entry", () => {
    setClaudeCodeToken("cc-NEW");
    writeAuth("anthropic", {
      mode: "claude-code",
      access_token: "cc-OLD",
    });

    const result = tryReimportClaudeCode(tmp);
    expect(result).toBe("cc-NEW");
    const stored = readAuth().anthropic as { access_token: string };
    expect(stored.access_token).toBe("cc-NEW");
  });

  it("does NOT override a manual setup token, even when Claude Code differs", () => {
    setClaudeCodeToken("cc-DIFFERENT");
    writeAuth("anthropic", {
      mode: "claude-setup-token",
      access_token: "sk-ant-oat-USER-PASTED",
    });

    const result = tryReimportClaudeCode(tmp);
    expect(result).toBeNull();
    const stored = readAuth().anthropic as { mode: string; access_token: string };
    expect(stored.mode).toBe("claude-setup-token");
    expect(stored.access_token).toBe("sk-ant-oat-USER-PASTED");
  });

  it("imports into a fresh dataDir when no entry exists yet", () => {
    setClaudeCodeToken("cc-FRESH");
    expect(fs.existsSync(path.join(tmp, "auth.json"))).toBe(false);

    const result = tryReimportClaudeCode(tmp);
    expect(result).toBe("cc-FRESH");
    const stored = readAuth().anthropic as { access_token: string };
    expect(stored.access_token).toBe("cc-FRESH");
  });
});
