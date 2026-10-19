CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`secret` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `api_keys_owner_id_idx` ON `api_keys` (`owner_id`);--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_invites_project_email_idx` ON `project_invites` (`project_id`,`email`);--> statement-breakpoint
CREATE INDEX `project_invites_email_idx` ON `project_invites` (`email`);--> statement-breakpoint
ALTER TABLE `projects` ADD `llm_provider` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `llm_model` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `llm_key_id` text REFERENCES api_keys(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `user` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
-- The oldest account on an existing server becomes its first admin.
UPDATE `user` SET `role` = 'admin' WHERE `id` = (SELECT `id` FROM `user` ORDER BY `created_at` LIMIT 1);