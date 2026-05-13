import { z } from "zod";
import { registry } from "../registry.js";
import { getCurrentSessionId } from "../session-context.js";

/**
 * `sleep` — per-session next-probe override the agent calls before
 * ending a turn. Sets `sessions.next_check_at`; the scheduler arms a
 * cron at that time and clears the field on fire. Override resets
 * each turn — the agent has to re-set if it still wants a custom
 * cadence. Without a call, the scheduler falls back to the agent's
 * default `probeIntervalMs`.
 *
 * Floor: 60s. Ceiling: 24h. `"never"` resolves to the ceiling — agents
 * can't permanently silence themselves; the watchdog also catches
 * runaway no-claim streaks regardless of this setting.
 *
 * Event-driven wakes (task assignments, comments, dep_unblocked) fire
 * whenever they fire and don't care about this setting. Sleep is the
 * fallback cadence when *nothing else* moves the world.
 */

const FLOOR_S = 60;
const CEILING_S = 24 * 60 * 60;

export interface SleepBindings {
  setNextCheckAt: (sessionId: string, unixSeconds: number) => void;
}

let bindings: SleepBindings | null = null;

export function bindSleep(b: SleepBindings): void {
  bindings = b;
}

const DESCRIPTION =
  "Set when the scheduler should next probe you (this session) if no events " +
  "fire in the meantime. Call at the end of a turn when you want to deviate " +
  "from the default cadence:\n\n" +
  "- `sleep(\"5m\")` — short cadence for high-frequency polling (\"is the build " +
  "green yet\"). Floor is 60s.\n" +
  "- `sleep(\"2h\")` — push the next probe further out when nothing's likely to " +
  "change before then.\n" +
  "- `sleep(\"never\")` — only wake on events; capped at 24h by the platform.\n\n" +
  "Events (task assignments, comments, dep unblocks, user messages) wake you " +
  "regardless — this is a fallback cadence, not a mute switch. The override " +
  "resets each turn; call it again if you still want a custom cadence next time.";

function parseDurationToUnixSeconds(input: string, now: number): number | null {
  const s = input.trim().toLowerCase();
  if (s === "never") return now + CEILING_S;
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
  name: "sleep",
  toolset: "system",
  description: DESCRIPTION,
  parameters: z.object({
    duration: z
      .string()
      .min(1)
      .describe(
        'How long until the next probe. Accepts relative durations like ' +
          '"30s" / "5m" / "2h" / "1d", an absolute ISO 8601 timestamp, or ' +
          '"never" (capped at 24h).'
      ),
  }),
  emoji: "⏰",
  parallelSafe: false,
  handler: async (args) => {
    const { duration } = args as { duration: string };
    if (!bindings) {
      return JSON.stringify({
        error:
          "sleep not initialized — AgentManager must call bindSleep().",
      });
    }
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      return JSON.stringify({
        error:
          "sleep requires an active session context (use during a turn).",
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const target = parseDurationToUnixSeconds(duration, now);
    if (target === null) {
      return JSON.stringify({
        error:
          `Could not parse duration ${JSON.stringify(duration)}. Use "5m", "2h", "1d", an ISO timestamp, or "never".`,
      });
    }
    // Clamp to [now+FLOOR, now+CEILING] — agents can't ask to be woken
    // sooner than the floor (cost bound) or later than the ceiling
    // (so a misjudgment can't disappear them forever).
    const clamped = Math.max(now + FLOOR_S, Math.min(target, now + CEILING_S));
    try {
      bindings.setNextCheckAt(sessionId, clamped);
      return JSON.stringify({
        acknowledged: true,
        next_check_at: new Date(clamped * 1000).toISOString(),
      });
    } catch (e) {
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
