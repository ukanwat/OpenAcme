CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author` text NOT NULL,
	`kind` text,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_comments_task` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_task_comments_kind` ON `task_comments` (`task_id`,`kind`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_events_task` ON `task_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_task_events_created` ON `task_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen_event_ts` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `sessions` SET `last_seen_event_ts` = (unixepoch());