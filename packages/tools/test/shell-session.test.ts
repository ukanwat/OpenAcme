import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  ShellSession,
  closeAllShellSessions,
  getShellSession,
} from "../src/internal/shell-session.js";

// Real bash-subprocess persistence: `cd`, env vars, shell functions all
// survive across calls within a session. Each test spawns its own
// ShellSession and disposes it in afterEach so we don't leak processes.

let tmp: string;
const live: ShellSession[] = [];

async function makeSession(): Promise<ShellSession> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-shell-session-"));
  const s = new ShellSession(tmp);
  live.push(s);
  return s;
}

afterEach(async () => {
  for (const s of live) s.close();
  live.length = 0;
  closeAllShellSessions();
  if (tmp) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

describe("ShellSession — per-session persistence", () => {
  it("starts in initialCwd", async () => {
    const s = await makeSession();
    const r = await s.exec("pwd", 5000);
    expect(r.exitCode).toBe(0);
    // macOS resolves /var/folders → /private/var/folders; accept both.
    expect(r.cwd === tmp || r.cwd === path.join("/private", tmp)).toBe(true);
  });

  it("`cd` persists across separate exec() calls", async () => {
    const s = await makeSession();
    await fs.mkdir(path.join(tmp, "sub"));
    const r1 = await s.exec("cd sub", 5000);
    expect(r1.exitCode).toBe(0);
    const r2 = await s.exec("pwd", 5000);
    expect(r2.exitCode).toBe(0);
    expect(r2.cwd.endsWith("/sub")).toBe(true);
  });

  it("exported env vars persist across calls", async () => {
    const s = await makeSession();
    const r1 = await s.exec("export OAC_TEST=hello", 5000);
    expect(r1.exitCode).toBe(0);
    const r2 = await s.exec("echo $OAC_TEST", 5000);
    expect(r2.exitCode).toBe(0);
    expect(r2.output.trim()).toBe("hello");
  });

  it("shell functions defined in one call are callable in the next", async () => {
    const s = await makeSession();
    await s.exec("greet() { echo \"hi $1\"; }", 5000);
    const r = await s.exec("greet world", 5000);
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("hi world");
  });

  it("non-zero exit codes are surfaced", async () => {
    const s = await makeSession();
    const r = await s.exec("false", 5000);
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it("stderr is merged into output (interactive-shell semantics)", async () => {
    const s = await makeSession();
    const r = await s.exec("echo to-out; echo to-err 1>&2", 5000);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("to-out");
    expect(r.output).toContain("to-err");
  });

  it("multi-line commands run as one block (state mutations chain)", async () => {
    const s = await makeSession();
    const r = await s.exec(
      "x=1\ny=2\necho $((x + y))",
      5000
    );
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe("3");
  });

  it("timeout resets the session and surfaces timedOut=true", async () => {
    const s = await makeSession();
    const r = await s.exec("sleep 5", 200);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    // Next call should still work — session is reset, back at initialCwd.
    const r2 = await s.exec("pwd", 5000);
    expect(r2.exitCode).toBe(0);
    expect(r2.cwd === tmp || r2.cwd === path.join("/private", tmp)).toBe(true);
  });

  it("getShellSession returns the same instance for the same key", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "openacme-ws-"));
    try {
      const a = getShellSession("agent-1", "session-1", ws);
      const b = getShellSession("agent-1", "session-1", ws);
      expect(a).toBe(b);
      const c = getShellSession("agent-1", "session-2", ws);
      expect(c).not.toBe(a);
    } finally {
      closeAllShellSessions();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
