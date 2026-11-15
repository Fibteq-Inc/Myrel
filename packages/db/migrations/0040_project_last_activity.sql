ALTER TABLE `projects` ADD `last_activity_at` integer;--> statement-breakpoint
-- Every person's message runs the coordinator, so its model calls date the work done so far.
UPDATE `projects` SET `last_activity_at` = (SELECT max(`created_at`) FROM `usage_events` WHERE `usage_events`.`project_id` = `projects`.`id`);
