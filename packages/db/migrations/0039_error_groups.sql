CREATE TABLE `error_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`where` text NOT NULL,
	`name` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `error_groups_last_seen_idx` ON `error_groups` (`last_seen_at`);