ALTER TABLE `projects` ADD `active_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `waiting_count` integer DEFAULT 0 NOT NULL;