// Resolves the base URL for API calls.
//
// In production the static export is served by the same Hono server that
// hosts the API, so same-origin (empty string) is correct. In dev the web
// app runs on :3000 while the server runs on :3210 — set
// NEXT_PUBLIC_API_URL=http://127.0.0.1:3210 in apps/web/.env.local to override.
export const API_BASE: string =
  (process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL.length > 0)
    ? process.env.NEXT_PUBLIC_API_URL
    : "";
