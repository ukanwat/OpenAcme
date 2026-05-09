import type { Hono } from "hono";
import { SESSION_COOKIE_NAME, verifySecret } from "../middleware/auth.js";

export interface AuthRoutesOptions {
  /** Hex-encoded SHA-256 of the configured secret. */
  secretSha256: string | null;
}

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

function buildCookie(value: string, opts: { secure: boolean }): string {
  // HttpOnly so JS can't read the cookie (mitigates XSS exfil).
  // SameSite=Lax so cross-site GETs don't carry credentials but top-level
  // navigation back from /login still sets the cookie.
  // Path=/ so it covers /api and HTML.
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function registerAuthRoutes(app: Hono, opts: AuthRoutesOptions): void {
  app.post("/api/auth/login", async (c) => {
    if (!opts.secretSha256) {
      return c.json({ error: "Auth disabled (no secret configured)" }, 400);
    }
    let body: { secret?: string };
    try {
      body = (await c.req.json()) as { secret?: string };
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const candidate = (body.secret ?? "").trim();
    if (!candidate) {
      return c.json({ error: "secret is required" }, 400);
    }
    if (!verifySecret(candidate, opts.secretSha256)) {
      return c.json({ error: "Invalid secret" }, 401);
    }
    // Mark Secure when the request arrived over HTTPS — without this a
    // browser on http://your-tunnel.ngrok.io won't store the cookie at all.
    const proto = c.req.header("x-forwarded-proto") ?? "";
    const url = c.req.url;
    const secure = proto === "https" || url.startsWith("https:");
    c.header("Set-Cookie", buildCookie(candidate, { secure }));
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    const proto = c.req.header("x-forwarded-proto") ?? "";
    const url = c.req.url;
    const secure = proto === "https" || url.startsWith("https:");
    c.header("Set-Cookie", clearCookie({ secure }));
    return c.json({ ok: true });
  });

  // Lightweight probe used by the login page to decide whether to render
  // the secret form at all (loopback bypass → no secret required → don't
  // even show the form).
  app.get("/api/auth/status", (c) => {
    return c.json({
      authRequired: opts.secretSha256 !== null,
    });
  });
}
