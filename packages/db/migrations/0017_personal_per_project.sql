CREATE TABLE `project_connectors` (
	`project_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`project_id`, `connector_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_id`) REFERENCES `connectors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_connectors_connector_idx` ON `project_connectors` (`connector_id`);--> statement-breakpoint
CREATE TABLE `project_skills` (
	`project_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`project_id`, `skill_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_skills_skill_idx` ON `project_skills` (`skill_id`);--> statement-breakpoint
-- Personal skills and connectors that exist already stay on where their owner is a member, as before.
INSERT OR IGNORE INTO `project_skills` (`project_id`, `skill_id`)
SELECT pm.`project_id`, s.`id` FROM `skills` s JOIN `project_members` pm ON pm.`user_id` = s.`owner_id` WHERE s.`owner_id` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `project_connectors` (`project_id`, `connector_id`)
SELECT pm.`project_id`, c.`id` FROM `connectors` c JOIN `project_members` pm ON pm.`user_id` = c.`owner_id` WHERE c.`owner_id` IS NOT NULL;
