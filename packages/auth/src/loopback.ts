import * as http from "node:http";

export interface LoopbackResult {
  code: string;
  state: string;
}

export interface LoopbackOptions {
  port: number;
  /**
   * State to validate against. Set to an empty string to skip state
   * validation entirely — required for OAuth 2.1 PKCE-only flows where
   * the authorization request omits `state` (the MCP SDK does this).
   * The localhost-only loopback + PKCE is sufficient for CSRF.
   */
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
          res.end(htmlPage({
            kind: "error",
            lead: `Sign-in failed: ${escapeHtml(error)}.`,
            detail: "You can close this tab and return to your terminal.",
          }));
          finish(() => reject(new Error(`OAuth error: ${error}`)));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlPage({
            kind: "error",
            lead: "Missing code.",
            detail: "You can close this tab and return to your terminal.",
          }));
          finish(() => reject(new Error("OAuth callback missing code")));
          return;
        }
        // State validation is skipped when `expectedState` is empty —
        // OAuth 2.1 PKCE-only flows (e.g. the MCP SDK) don't include
        // `state` in the authorization request.
        if (expectedState !== "") {
          if (!state) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(htmlPage({
              kind: "error",
              lead: "Missing state.",
              detail: "You can close this tab and return to your terminal.",
            }));
            finish(() => reject(new Error("OAuth callback missing state")));
            return;
          }
          if (state !== expectedState) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(htmlPage({
              kind: "error",
              lead: "State mismatch.",
              detail: "You can close this tab and return to your terminal.",
            }));
            finish(() => reject(new Error("OAuth state mismatch")));
            return;
          }
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlPage({
          kind: "ok",
          lead: "Sign-in complete.",
          detail: "You can close this tab and return to your terminal.",
        }));
        finish(() => resolve({ code, state: state ?? "" }));
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

interface PageOpts {
  lead: string;
  detail?: string;
  kind?: "ok" | "error";
}

function htmlPage({ lead, detail, kind = "ok" }: PageOpts): string {
  const statusLabel = kind === "ok" ? "OK" : "FAILED";
  const detailHtml = detail ? `<p class="detail">${detail}</p>` : "";
  // Self-contained: mirrors globals.css tokens (paper/ink/plot-red) +
  // faceplate-label typography so the OAuth round-trip lands on a page
  // that looks like the rest of the app. prefers-color-scheme drives
  // dark mode — there's no app shell here to read localStorage from.
  const noise = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22180%22%20height%3D%22180%22%3E%3Cfilter%20id%3D%22n%22%3E%3CfeTurbulence%20type%3D%22fractalNoise%22%20baseFrequency%3D%220.85%22%20numOctaves%3D%222%22%20stitchTiles%3D%22stitch%22%2F%3E%3CfeColorMatrix%20values%3D%220%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200%200.6%200%22%2F%3E%3C%2Ffilter%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20filter%3D%22url(%23n)%22%2F%3E%3C%2Fsvg%3E";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenAcme — Authentication</title>
<style>
:root {
  --paper: oklch(98.5% 0.004 75);
  --paper-rule: oklch(86% 0.004 75);
  --ink: oklch(22% 0.008 280);
  --ink-soft: oklch(42% 0.006 280);
  --ink-faint: oklch(54% 0.006 280);
  --plot-red: oklch(58% 0.18 28);
  --signal-green: oklch(60% 0.13 150);
  --noise-opacity: 0.022;
  --noise-blend: multiply;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: oklch(16% 0.006 280);
    --paper-rule: oklch(28% 0.006 280);
    --ink: oklch(94% 0.004 75);
    --ink-soft: oklch(75% 0.005 75);
    --ink-faint: oklch(58% 0.005 280);
    --plot-red: oklch(62% 0.19 28);
    --signal-green: oklch(72% 0.16 150);
    --noise-opacity: 0.05;
    --noise-blend: screen;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  padding: 16px;
  background: var(--paper);
  color: var(--ink);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-feature-settings: "tnum", "calt";
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  isolation: isolate;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: -1;
  background-image: url("${noise}");
  opacity: var(--noise-opacity);
  mix-blend-mode: var(--noise-blend);
}
.card {
  width: 100%;
  max-width: 440px;
  background: var(--paper);
  border: 1px solid var(--paper-rule);
  animation: section-enter 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.rule {
  height: 1px;
  background: var(--ink);
  transform-origin: left center;
  animation: scribe-in 320ms cubic-bezier(0.25, 1, 0.5, 1) both;
}
.rule.faint { background: var(--paper-rule); animation-delay: 180ms; }
.head { padding: 14px 20px 12px; }
.label {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
  line-height: 1;
  display: inline-block;
}
.brand { color: var(--plot-red); }
.body { padding: 22px 20px 20px; }
.lead {
  margin: 0;
  color: var(--ink);
  font-size: 16px;
  font-weight: 500;
  letter-spacing: -0.005em;
}
.detail {
  margin: 8px 0 0;
  color: var(--ink-soft);
  font-size: 13.5px;
}
.foot {
  padding: 12px 20px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--signal-green);
  flex-shrink: 0;
}
.dot.error { background: var(--plot-red); }
.status-value.ok    { color: var(--signal-green); }
.status-value.error { color: var(--plot-red); }
.sep { color: var(--paper-rule); }
.status-value { color: var(--ink-soft); }
::selection {
  background-color: color-mix(in oklch, var(--plot-red) 22%, transparent);
  color: var(--ink);
}
@keyframes section-enter {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes scribe-in {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}
@media (prefers-reduced-motion: reduce) {
  .card, .rule { animation: none !important; transform: none; }
}
</style>
</head>
<body>
  <main class="card" role="status">
    <div class="rule" aria-hidden="true"></div>
    <div class="head">
      <span class="label"><span class="brand">OPENACME</span> · AUTHENTICATION</span>
    </div>
    <div class="rule faint" aria-hidden="true"></div>
    <div class="body">
      <p class="lead">${lead}</p>
      ${detailHtml}
    </div>
    <div class="foot">
      <span class="dot${kind === "error" ? " error" : ""}" aria-hidden="true"></span>
      <span>Status</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="status-value ${kind}">${statusLabel}</span>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
