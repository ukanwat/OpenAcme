import * as http from "node:http";

export interface LoopbackResult {
  code: string;
  state: string;
}

export interface LoopbackOptions {
  port: number;
  expectedState: string;
  /** Path the OAuth provider redirects to. Default: /auth/callback */
  callbackPath?: string;
  /** Max wait before rejecting. Default: 5 minutes. */
  timeoutMs?: number;
}

/**
 * Start an ephemeral HTTP server that captures one OAuth callback.
 * Resolves with `{code, state}`, rejects on state mismatch / timeout / port-busy.
 * The server always shuts down before the promise settles.
 */
export function awaitLoopbackCallback(opts: LoopbackOptions): Promise<LoopbackResult> {
  const { port, expectedState, callbackPath = "/auth/callback", timeoutMs = 5 * 60_000 } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* noop */ }
      clearTimeout(timer);
      fn();
    };

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (reqUrl.pathname !== callbackPath) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }

        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage(`Sign-in failed: ${escapeHtml(error)}. You can close this tab.`));
          finish(() => reject(new Error(`OAuth error: ${error}`)));
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage("Missing code or state. You can close this tab."));
          finish(() => reject(new Error("OAuth callback missing code or state")));
          return;
        }
        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage("State mismatch. You can close this tab."));
          finish(() => reject(new Error("OAuth state mismatch")));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage("Sign-in complete. You can close this tab and return to your terminal."));
        finish(() => resolve({ code, state }));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish(() => reject(new Error(
          `Port ${port} is already in use. Close any other CLI running an OAuth flow ` +
          `(e.g. Codex CLI), or run \`openacme login --device\` to use the device-code flow instead.`
        )));
      } else {
        finish(() => reject(err));
      }
    });

    server.listen(port, "127.0.0.1");

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for OAuth callback after ${timeoutMs / 1000}s`)));
    }, timeoutMs);
  });
}

function htmlPage(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>OpenAcme</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b1220;color:#e2e8f0}div{max-width:480px;padding:32px;border-radius:12px;background:#111827;border:1px solid #1f2937;text-align:center}h1{font-size:18px;margin:0 0 12px;color:#7dd3fc}</style>
</head><body><div><h1>OpenAcme</h1><p>${body}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
