-- Adds `agent_inbox` (per-agent delivery queue, temporary rows that get
-- drained at turn start / step boundary, then hard-deleted) and
-- `sessions.defer_until` (one-shot "skip routine spawns until this time"
-- the agent sets via `defer_session(duration)`). See plan in
-- ~/.claude/plans/eager-strolling-cocke.md for the surrounding redesign.
--
-- This migration only ADDS columns/tables — `sessions.next_check_at` and
-- `sessions.last_seen_event_ts` are scheduled for removal in a later
-- commit once the cron-arm and event-cursor paths are gone.

CREATE TABLE `agent_inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text,
	`related_task` text,
	`related_session` text,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_inbox_agent` ON `agent_inbox` (`agent_id`,`id`);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `defer_until` integer;
