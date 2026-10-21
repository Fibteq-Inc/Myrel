CREATE TABLE `billing_trials` (
	`email_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sandbox_runs` ADD `billed_to` text;--> statement-breakpoint
CREATE INDEX `sandbox_runs_billed_ended_idx` ON `sandbox_runs` (`billed_to`,`ended_at`);--> statement-breakpoint
ALTER TABLE `usage_events` ADD `billed_to` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `service_key` integer;--> statement-breakpoint
CREATE INDEX `usage_events_billed_created_idx` ON `usage_events` (`billed_to`,`created_at`);--> statement-breakpoint
UPDATE `usage_events` SET
  `billed_to` = (SELECT `created_by` FROM `projects` WHERE `projects`.`id` = `usage_events`.`project_id`),
  `service_key` = (SELECT `p`.`llm_key_id` IS NULL OR `p`.`llm_key_id` IN (SELECT `id` FROM `api_keys` WHERE `owner_id` IS NULL)
    FROM `projects` `p` WHERE `p`.`id` = `usage_events`.`project_id`);--> statement-breakpoint
UPDATE `sandbox_runs` SET `billed_to` = (SELECT `created_by` FROM `projects` WHERE `projects`.`id` = `sandbox_runs`.`project_id`);
