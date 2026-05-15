-- Adds `sessions.next_check_at` (per-session probe override the agent
-- sets via `sleep`), and makes the event log polymorphic across task
-- events and session-level events (e.g. `ping_user` where there's no
-- task in scope). Constraint: at least one of (task_id, session_id) is
-- non-null — enforced at write time in EventStore.append.

ALTER TABLE `sessions` ADD `next_check_at` integer;
--> statement-breakpoint
-- SQLite can't drop a NOT NULL constraint in place; recreate the table.
-- Existing rows preserve their `task_id` (they're all task-anchored
-- pre-migration); `session_id` is left null and will be populated on
-- new writes from EventStore.append.
ALTER TABLE `task_events` RENAME TO `task_events_old`;
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`session_id` text,
	`agent_id` text NOT NULL,
	`actor` text,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `task_events` (`id`, `task_id`, `session_id`, `agent_id`, `actor`, `kind`, `payload`, `created_at`)
  SELECT `id`, `task_id`, NULL, `agent_id`, `actor`, `kind`, `payload`, `created_at`
  FROM `task_events_old`;
--> statement-breakpoint
DROP TABLE `task_events_old`;
--> statement-breakpoint
CREATE INDEX `idx_task_events_task` ON `task_events` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_session` ON `task_events` (`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_created` ON `task_events` (`created_at`);
