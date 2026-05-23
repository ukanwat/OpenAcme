import type { Context, MiddlewareHandler } from "hono";
import * as crypto from "node:crypto";

const SESSION_COOKIE = "openacme_session";
// Loopback host names that bypass auth. Match the host *header*, not the
// connection IP — tunnels (ngrok / Cloudflare) forward to 127.0.0.1 but
// preserve the user-facing hostname in Host, so the bypass correctly
// fails for them.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface AuthOptions {
  /** Hex-encoded SHA-256 of the secret. Null when no secret is configured. */
  secretSha256: string | null;
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip the port: "localhost:3210" → "localhost", "[::1]:3210" → "[::1]".
  let host = hostHeader.trim();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close > 0) host = host.slice(0, close + 1);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon > 0) host = host.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(host);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** True if the candidate matches the configured secret. */
export function verifySecret(candidate: string, secretSha256: string | null): boolean {
  if (!secretSha256) return false;
  return timingSafeEqualHex(sha256Hex(candidate), secretSha256);
}

/**
 * Auth middleware. Loopback Host bypasses; everything else requires a
 * matching cookie or Bearer token. /api/* gets a 401, everything else gets
 * a 302 to /login (for the static web bundle's HTML routes).
 *
 * /api/auth/* and /login itself are whitelisted — login routes must remain
 * reachable without a cookie.
 */
export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  return async (c: Context, next) => {
    const path = c.req.path;
    if (path === "/login" || path === "/login.html" || path.startsWith("/api/auth/")) {
      return next();
    }
    // Static assets referenced by the login page itself must bypass auth,
    // otherwise the login HTML loads but its CSS/JS bundles get redirected
    // to /login — page renders unstyled and React never hydrates so the
    // submit button stays disabled forever.
    if (
      path.startsWith("/_next/") ||
      path === "/favicon.ico" ||
      path.startsWith("/favicon")
    ) {
      return next();
    }
    // PWA discovery assets must be reachable pre-login — iOS won't offer
    // "Add to Home Screen" if it can't fetch the manifest, and the service
    // worker's initial GET happens on tab load before any login cookie
    // exists. Same-origin so still SOP-protected. Exact filenames only so
    // a `prefix` match can't be abused (e.g. /icon-../foo.png paths —
    // Hono normalizes, but defense-in-depth).
    if (
      path === "/manifest.webmanifest" ||
      path === "/sw.js" ||
      path === "/apple-touch-icon.png" ||
      path === "/icon-192.png" ||
      path === "/icon-512.png" ||
      path === "/icon-maskable-512.png"
    ) {
      return next();
    }
    if (isLoopbackHost(c.req.header("host"))) return next();

    if (!opts.secretSha256) {
      // Daemon was bound non-loopback without a secret. Fail closed.
      return c.json(
        {
          error:
            "Server is exposed beyond loopback but no secret is configured. " +
            "Run `openacme expose` from the host to generate one.",
        },
        500
      );
    }

    const cookie = parseCookie(c.req.header("cookie"), SESSION_COOKIE);
    const auth = c.req.header("authorization") ?? "";
    const bearer = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null;
    const candidate = cookie ?? bearer;

    if (candidate && verifySecret(candidate, opts.secretSha256)) {
      return next();
    }

    if (path.startsWith("/api/")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // For HTML page loads (Next.js static export), redirect to /login with
    // ?next=… so the browser comes back where it was going.
    const next_ = encodeURIComponent(path + (c.req.url.includes("?") ? c.req.url.slice(c.req.url.indexOf("?")) : ""));
    return c.redirect(`/login?next=${next_}`);
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
