// All API calls are same-origin. In production the Hermes server serves
// the static export and the API on the same port. In dev `next dev` proxies
// /api/* to the Hermes server (see next.config.js rewrites), so the frontend
// never needs to know the server's host or port.
export const API_BASE = "";
