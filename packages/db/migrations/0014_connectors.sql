CREATE TABLE `connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`project_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`transport` text NOT NULL,
	`url` text,
	`auth` text DEFAULT 'headers' NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`runs_on` text DEFAULT 'both' NOT NULL,
	`secret` text,
	`secret_names` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_error` text,
	`tools` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_owner_slug_idx` ON `connectors` (`owner_id`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `connectors_project_slug_idx` ON `connectors` (`project_id`,`slug`);