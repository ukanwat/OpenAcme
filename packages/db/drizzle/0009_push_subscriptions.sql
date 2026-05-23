-- Web Push subscriptions. One row per device endpoint; single-operator
-- deployment so no user_id column. `endpoint` is unique because the
-- subscribe path on the client may re-subscribe on every PWA launch
-- (iOS quietly drops subscriptions), and we want re-subscribe to be a
-- no-op rather than an orphan-row pile-up. Key material lives only on
-- this row; never expose `p256dh` / `auth` over the API.

CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);
