import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentSessionId } from "../session-context.js";

/**
 * `defer_session` — agent calls this when there's nothing actionable
 * right now and it wants to suppress routine dispatcher checks for a
 * while. Writes `sessions.defer_until`; the dispatcher's periodic
 * tick honours it.
 *
 * Floor: 60 s. Ceiling: 24 h. `"never"` is intentionally NOT supported
 * — the agent shouldn't be able to disappear itself permanently, and
 * the old `sleep("never")` tool was a fiction (it silently clamped to
 * 24 h anyway).
 *
 * IMPORTANT: defer is for routine-check suppression only. New inbox
 * rows — a comment from a human, a new task assignment, an event the
 * agent should know about — bypass the defer. The dispatcher's spawn
 * rule checks inbox count; non-zero overrides any defer window. This
 * is the "skip the noise, not the signal" contract.
 *
 * One-shot: the dispatcher clears `defer_until` on actual spawn, so
 * the agent must re-call this tool on each turn it wants to defer.
 * That's by design — sticky deferral would make recovery from a
 * misjudged duration painful.
 */

const FLOOR_S = 60;
const CEILING_S = 24 * 60 * 60;

export interface DeferSessionBindings {
  setDeferUntil: (sessionId: string, unixSeconds: number) => void;
}

let bindings: DeferSessionBindings | null = null;

export function bindDeferSession(b: DeferSessionBindings): void {
  bindings = b;
}

const DESCRIPTION =
  "Suppress routine dispatcher checks on this session until a given " +
  "time. Call at the end of a turn when nothing's actionable right " +
  "now and you'd rather not be re-spawned every 60 s. Examples:\n\n" +
  "- `defer_session(\"5m\")` — short break; check back in 5 minutes.\n" +
  "- `defer_session(\"2h\")` — push the next check out 2 hours.\n" +
  "- `defer_session(\"24h\")` — maximum quiet period (the ceiling).\n\n" +
  "Real signals (a user message, a new task assigned to you, a " +
  "comment from another agent) bypass the defer and wake you " +
  "immediately. Defer suppresses *noise*, not *signal*. The override " +
  "resets each turn; call it again if you want to stay quiet next " +
  "turn too.";

function parseDurationToUnixSeconds(input: string, now: number): number | null {
  const s = input.trim().toLowerCase();
  // Relative: "5m", "2h", "30s", "1d", "90"
  const rel = s.match(/^(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)?$/);
  if (rel) {
    const n = parseInt(rel[1]!, 10);
    const unit = (rel[2] ?? "s")[0];
    const multiplier =
      unit === "s"
        ? 1
        : unit === "m"
          ? 60
          : unit === "h"
            ? 3600
            : 86_400;
    return now + n * multiplier;
  }
  // Absolute ISO timestamp.
  const ms = Date.parse(input);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return null;
}

registry.register({
  name: "defer_session",
  toolset: "system",
  description: DESCRIPTION,
  parameters: z.object({
    duration: z
      .string()
      .min(1)
      .describe(
        'How long to defer. Accepts relative durations like "30s" / ' +
          '"5m" / "2h" / "1d" (floor 60s, ceiling 24h), or an ' +
          'absolute ISO 8601 timestamp. No "never" — capped at 24h.'
      ),
  }),
  emoji: "⏰",
  parallelSafe: false,
  handler: async (args) => {
    const { duration } = args as { duration: string };
    if (!bindings) {
      return JSON.stringify({
        error:
          "defer_session not initialized — AgentManager must call bindDeferSession().",
      });
    }
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      return JSON.stringify({
        error:
          "defer_session requires an active session context (use during a turn).",
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const target = parseDurationToUnixSeconds(duration, now);
    if (target === null) {
      return JSON.stringify({
        error:
          `Could not parse duration ${JSON.stringify(duration)}. Use "5m", "2h", "24h", "1d", or an ISO timestamp. "never" is not supported — use "24h" instead.`,
      });
    }
    // Clamp to [now+FLOOR, now+CEILING] — agents can't ask to be woken
    // sooner than the floor (cost bound) or later than the ceiling
    // (so a misjudgment can't disappear them forever).
    const clamped = Math.max(now + FLOOR_S, Math.min(target, now + CEILING_S));
    try {
      bindings.setDeferUntil(sessionId, clamped);
      return JSON.stringify({
        acknowledged: true,
        defer_until: new Date(clamped * 1000).toISOString(),
      });
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
