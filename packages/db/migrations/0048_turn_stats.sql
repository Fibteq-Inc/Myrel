CREATE TABLE `turn_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text,
	`user_id` text,
	`runtime` text NOT NULL,
	`harness` text NOT NULL,
	`provider` text,
	`model` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cached_input_tokens` integer,
	`output_tokens` integer NOT NULL,
	`model_ms` integer,
	`wait_ms` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`unpriced_calls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_stats_project_ended_idx` ON `turn_stats` (`project_id`,`ended_at`);--> statement-breakpoint
CREATE INDEX `turn_stats_user_idx` ON `turn_stats` (`user_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `turn_history` integer DEFAULT false NOT NULL;