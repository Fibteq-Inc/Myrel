ALTER TABLE `billing_subscriptions` ADD `source` text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_subscriptions` ADD `store_product_id` text;