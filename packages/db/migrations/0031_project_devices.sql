-- D1 ignores foreign_keys=OFF; nothing references this table, so a deferred check is enough.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_project_workspaces` (
	`project_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`path` text NOT NULL,
	`folders` text DEFAULT '[]' NOT NULL,
	`cli` text NOT NULL,
	`created_by` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`project_id`, `runner_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_project_workspaces`("project_id", "runner_id", "path", "folders", "cli", "created_by", "is_default", "created_at", "updated_at") SELECT "project_id", "runner_id", "path", "folders", "cli", "created_by", 1, "created_at", "updated_at" FROM `project_workspaces`;--> statement-breakpoint
DROP TABLE `project_workspaces`;--> statement-breakpoint
ALTER TABLE `__new_project_workspaces` RENAME TO `project_workspaces`;--> statement-breakpoint
CREATE INDEX `project_workspaces_runner_id_idx` ON `project_workspaces` (`runner_id`);