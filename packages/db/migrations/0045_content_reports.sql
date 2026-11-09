CREATE TABLE `content_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text,
	`project_id` text NOT NULL,
	`thread_id` text,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`version` integer,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`excerpt` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`reporter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `content_reports_created_idx` ON `content_reports` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_reports_once_idx` ON `content_reports` (`reporter_id`,`kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `user_blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`project_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
