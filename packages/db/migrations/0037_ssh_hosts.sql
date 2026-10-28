CREATE TABLE `project_ssh_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`alias` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`user` text NOT NULL,
	`runner_id` text NOT NULL,
	`key_source` text DEFAULT 'new' NOT NULL,
	`public_key` text,
	`key_fingerprint` text,
	`host_key` text,
	`host_fingerprint` text,
	`rule` text DEFAULT 'ask' NOT NULL,
	`tested_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runner_id`) REFERENCES `runners`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_ssh_hosts_alias_idx` ON `project_ssh_hosts` (`project_id`,`alias`);--> statement-breakpoint
CREATE INDEX `project_ssh_hosts_runner_id_idx` ON `project_ssh_hosts` (`runner_id`);--> statement-breakpoint
CREATE TABLE `ssh_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`host_id` text,
	`alias` text NOT NULL,
	`thread_id` text,
	`command` text NOT NULL,
	`reason` text,
	`decision` text NOT NULL,
	`approved_by` text,
	`exit_code` integer,
	`ms` integer,
	`output` text,
	`at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`host_id`) REFERENCES `project_ssh_hosts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ssh_audit_project_at_idx` ON `ssh_audit` (`project_id`,`at`);