CREATE TABLE `github_user_repos` (
	`user_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	PRIMARY KEY(`user_id`, `installation_id`, `repo_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`id`) ON UPDATE no action ON DELETE cascade
);
