CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`project_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`source` text NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_owner_name_idx` ON `skills` (`owner_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `skills_project_name_idx` ON `skills` (`project_id`,`name`);