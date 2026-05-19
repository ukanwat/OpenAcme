/**
 * Client-side navigation helper.
 *
 * Next.js's App Router (`router.push` / `router.replace` / `<Link>`)
 * silently no-ops on same-route URL changes when the app is built with
 * `output: "export"`. The static export ships HTML for each path but
 * Next's runtime intercepts the click, computes "no route change", and
 * skips the navigation — leaving the URL stale and the page unable to
 * react.
 *
 * This helper uses raw `history.pushState` + a manual `popstate` event
 * so `useSearchParams()` (and any other Next hooks that subscribe to
 * navigation) re-render with the new URL. Use it for any "stay on the
 * `/` route, just change the query string" case: home from a session,
 * session pick from HomeView, new-chat from sidebar, agent-filter
 * toggles, delete-cleanup, etc.
 *
 * Genuine route changes (e.g. `/agents` ← from `/`) should still use
 * Next's `<Link>` or `router.push` — those work because they ARE a
 * route change and the runtime handles them.
 */
export function navigateClient(href: string): void {
  if (typeof window === "undefined") return;
  if (href === window.location.pathname + window.location.search) return;
  window.history.pushState(null, "", href);
  // Next's `useSearchParams` listens for `popstate`, not `pushState`,
  // so dispatch one explicitly.
  window.dispatchEvent(new PopStateEvent("popstate"));
}
