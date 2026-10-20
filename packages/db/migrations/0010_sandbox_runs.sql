CREATE TABLE `sandbox_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`seconds` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sandbox_runs_project_ended_idx` ON `sandbox_runs` (`project_id`,`ended_at`);