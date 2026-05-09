"use client";

import { useEffect } from "react";

/**
 * Wrap window.fetch once on mount so every API call:
 *   1. sends the session cookie (credentials: "include")
 *   2. on 401 from /api/* (excluding /api/auth/*), redirects the browser
 *      to /login with a `next` param so the user lands back where they
 *      were trying to go.
 *
 * The web is served same-origin from Hono in production, so credentials
 * default to "same-origin" already — but Next.js dev runs at :3000 and
 * proxies via rewrites to :3210; cookies still travel because the dev
 * rewrite makes it look same-origin to the browser. Setting "include"
 * explicitly future-proofs us if anyone hard-codes a cross-origin URL.
 */
export function AuthFetch(): null {
  useEffect(() => {
    const original = window.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      const merged: RequestInit = { credentials: "include", ...init };
      const res = await original(input, merged);
      if (res.status === 401) {
        const urlString = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        const isApi = urlString.includes("/api/");
        const isAuth = urlString.includes("/api/auth/");
        if (isApi && !isAuth && typeof window !== "undefined") {
          const next = encodeURIComponent(
            window.location.pathname + window.location.search
          );
          window.location.href = `/login?next=${next}`;
        }
      }
      return res;
    };
    window.fetch = wrapped;
    return () => {
      window.fetch = original;
    };
  }, []);
  return null;
}
