CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text,
	`user_id` text,
	`agent` text NOT NULL,
	`turn_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`served_model` text,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_micros` integer,
	`latency_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_events_project_created_idx` ON `usage_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `usage_events_user_created_idx` ON `usage_events` (`user_id`,`created_at`);