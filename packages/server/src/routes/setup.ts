import type { Hono } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import {
  oauthLoginOpenAI,
  loginWithClaudeCodeCredentials,
  looksHeadless,
} from "@openacme/auth";

export interface SetupRoutesOptions {
  dataDir: string;
}

/**
 * Provider-credential setup routes invoked by the chat-onboarding panel.
 * Mounted under /api/setup/* so the access-secret middleware applies on
 * non-loopback daemons — /api/auth/* is whitelisted and would bypass it.
 */
export function registerSetupRoutes(app: Hono, opts: SetupRoutesOptions): void {
  // OpenAI: blocks until the existing CLI loopback flow on :1455 receives
  // the callback (or its internal 5-minute timeout fires). The web side
  // shows a "waiting" state for the duration of this request.
  app.post("/api/setup/oauth-start", async (c) => {
    let body: { provider?: string };
    try {
      body = (await c.req.json()) as { provider?: string };
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (body.provider !== "openai") {
      return c.json(
        {
          error:
            "Only OpenAI supports browser OAuth from the web today. " +
            "For Anthropic, paste a Claude setup token or import from Claude Code.",
        },
        400
      );
    }
    if (looksHeadless()) {
      return c.json(
        {
          error:
            "Daemon can't open a browser (no display detected). " +
            "Use `openacme login --provider openai --device` from a terminal.",
        },
        400
      );
    }
    try {
      const result = await oauthLoginOpenAI({
        dataDir: opts.dataDir,
        flow: "browser",
      });
      return c.json({ success: true, email: result.email ?? null });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "OAuth failed" },
        500
      );
    }
  });

  // Claude Code keychain import. Explicit `importNow: true` body required
  // because on macOS this triggers a Touch ID / keychain prompt — never
  // expose passively.
  app.post("/api/setup/anthropic-claude-code-import", async (c) => {
    let body: { importNow?: boolean };
    try {
      body = (await c.req.json()) as { importNow?: boolean };
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (body.importNow !== true) {
      return c.json({ error: "importNow must be true" }, 400);
    }
    try {
      const result = loginWithClaudeCodeCredentials(opts.dataDir);
      if (!result) {
        return c.json({ error: "no Claude Code credentials found" }, 404);
      }
      return c.json({ imported: true });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "import failed" },
        500
      );
    }
  });

  // File-existence probe only — does NOT read keychain or contents.
  // Drives whether the panel surfaces the "Import from Claude Code" button.
  app.get("/api/setup/claude-code-available", (c) => {
    const home = homedir();
    const candidates = [
      join(home, ".claude", ".credentials.json"),
      join(home, ".claude.json"),
    ];
    const available = candidates.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    return c.json({ available });
  });
}
