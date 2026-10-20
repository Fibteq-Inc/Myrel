CREATE TABLE `pull_requests` (
	`repo_id` integer NOT NULL,
	`number` integer NOT NULL,
	`full_name` text NOT NULL,
	`installation_id` integer NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`head_sha` text NOT NULL,
	`head_ref` text NOT NULL,
	`checks` text,
	`review` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`repo_id`, `number`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_requests_project_id_idx` ON `pull_requests` (`project_id`,`thread_id`);