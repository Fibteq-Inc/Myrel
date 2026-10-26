CREATE TABLE `billing_gifts` (
	`id` text PRIMARY KEY NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`months` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_by` text,
	`redeemed_at` integer,
	`subscription_id` text,
	`revoked_at` integer
);
