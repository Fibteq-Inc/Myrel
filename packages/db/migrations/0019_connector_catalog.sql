CREATE TABLE `connector_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`website_url` text,
	`icon_url` text,
	`url` text NOT NULL,
	`auth` text NOT NULL,
	`header_name` text,
	`header_placeholder` text,
	`version` text NOT NULL,
	`registry_updated_at` text NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connector_catalog_title_idx` ON `connector_catalog` (`title`);--> statement-breakpoint
CREATE TABLE `connector_catalog_sync` (
	`id` text PRIMARY KEY NOT NULL,
	`since` text,
	`cursor` text,
	`updated_at` integer NOT NULL
);
