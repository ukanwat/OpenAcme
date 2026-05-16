-- Drop the two legacy session-scoped fields that the
-- dispatcher+inbox redesign supersedes:
--
--   * `next_check_at`  — fed by the `sleep` tool. Replaced by
--     `defer_until` (set by `defer_session(duration)`) which the
--     dispatcher's tick honours directly. The cron-arm probe path
--     it backed is gone.
--
--   * `last_seen_event_ts` — per-session cursor over the event log,
--     read by the old `runAutonomous` to render "Recent activity
--     since you last looked". The agent inbox (per-agent, delete-on-
--     deliver) handles incrementality now; the cursor has no reader.
--
-- SQLite allows `ALTER TABLE ... DROP COLUMN` since 3.35; we're well
-- past that floor.

ALTER TABLE `sessions` DROP COLUMN `next_check_at`;
--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `last_seen_event_ts`;
