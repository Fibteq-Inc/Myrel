CREATE TABLE `sandbox_active` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`billed_to` text
);
--> statement-breakpoint
CREATE INDEX `sandbox_active_billed_idx` ON `sandbox_active` (`billed_to`,`started_at`);