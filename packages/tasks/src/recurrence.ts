import { Cron } from "croner";
import {
  MIN_INTERVAL_MS,
  MAX_RECURRENCE_COUNT,
  type Recurrence,
} from "./types.js";

export type ValidateResult = { ok: true } | { ok: false; message: string };

/**
 * Compute the next fire time for a recurrence, or null if the schedule
 * is exhausted (count cap, until cap, or cron expression that yields no
 * future runs). Pure — does not start a Croner timer.
 */
export function computeNextFire(
  rec: Recurrence,
  from: Date,
  runs: number
): Date | null {
  if (rec.until) {
    const u = Date.parse(rec.until);
    if (Number.isFinite(u) && u <= from.getTime()) return null;
  }
  if (rec.count != null && runs >= rec.count) return null;

  let candidate: Date | null;
  if (rec.kind === "cron") {
    try {
      const cron = new Cron(rec.expr, {
        timezone: rec.tz ?? undefined,
        paused: true,
      });
      candidate = cron.nextRun(from);
    } catch {
      return null;
    }
  } else {
    candidate = new Date(from.getTime() + rec.every_ms);
  }

  if (!candidate) return null;
  if (rec.until) {
    const u = Date.parse(rec.until);
    if (Number.isFinite(u) && candidate.getTime() > u) return null;
  }
  return candidate;
}

/**
 * Validate a recurrence at the write boundary. Cheaper than waiting for
 * Croner to throw when the daemon eventually arms a malformed expr.
 */
export function validateRecurrence(
  rec: Recurrence,
  now: Date
): ValidateResult {
  if (rec.until) {
    const u = Date.parse(rec.until);
    if (!Number.isFinite(u)) {
      return { ok: false, message: `recurrence.until is not a valid ISO date` };
    }
    if (u <= now.getTime()) {
      return { ok: false, message: `recurrence.until is in the past` };
    }
  }
  if (rec.count != null) {
    if (!Number.isInteger(rec.count) || rec.count <= 0) {
      return { ok: false, message: `recurrence.count must be a positive integer` };
    }
    if (rec.count > MAX_RECURRENCE_COUNT) {
      return {
        ok: false,
        message: `recurrence.count exceeds max (${MAX_RECURRENCE_COUNT})`,
      };
    }
  }

  if (rec.kind === "cron") {
    try {
      const cron = new Cron(rec.expr, {
        timezone: rec.tz ?? undefined,
        paused: true,
      });
      const next = cron.nextRun(now);
      if (!next) {
        return {
          ok: false,
          message: `recurrence.expr ${JSON.stringify(rec.expr)} has no future runs`,
        };
      }
    } catch (e) {
      return {
        ok: false,
        message: `recurrence.expr invalid: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    return { ok: true };
  }

  // interval
  if (!Number.isInteger(rec.every_ms) || rec.every_ms < MIN_INTERVAL_MS) {
    return {
      ok: false,
      message: `recurrence.every_ms must be an integer >= ${MIN_INTERVAL_MS}`,
    };
  }
  return { ok: true };
}

/** One-line cadence label for prompt rendering. */
export function describeRecurrence(rec: Recurrence): string {
  if (rec.kind === "cron") {
    return rec.tz ? `cron ${rec.expr} (${rec.tz})` : `cron ${rec.expr}`;
  }
  return `every ${formatMs(rec.every_ms)}`;
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}
