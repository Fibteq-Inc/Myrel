ALTER TABLE `connector_catalog` ADD `category` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
CREATE INDEX `connector_catalog_category_idx` ON `connector_catalog` (`category`);--> statement-breakpoint
-- Copy the whole registry again so every server gets a category.
UPDATE `connector_catalog_sync` SET `since` = NULL, `cursor` = NULL;--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'productivity' WHERE `id` = 'com.notion/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'productivity' WHERE `id` = 'app.linear/linear';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'productivity' WHERE `id` = 'com.atlassian/atlassian-mcp-server';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'design' WHERE `id` = 'com.figma.mcp/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'finance' WHERE `id` = 'com.stripe/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'design' WHERE `id` = 'com.canva.mcp/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'developer' WHERE `id` = 'com.vercel/vercel-mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'developer' WHERE `id` = 'com.gitlab/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'data' WHERE `id` = 'io.github.PostHog/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'productivity' WHERE `id` = 'com.zapier/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'data' WHERE `id` = 'com.airtable/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'productivity' WHERE `id` = 'com.monday/monday.com';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'finance' WHERE `id` = 'com.paypal.mcp/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'design' WHERE `id` = 'com.webflow/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'design' WHERE `id` = 'com.wix/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'developer' WHERE `id` = 'com.neon/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'developer' WHERE `id` = 'com.railway/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'ai' WHERE `id` = 'co.huggingface/hf-mcp-server';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'developer' WHERE `id` = 'com.cloudflare.mcp/mcp';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'search' WHERE `id` = 'com.apify/apify-mcp-server';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'search' WHERE `id` = 'ai.exa/exa';--> statement-breakpoint
UPDATE `connector_catalog` SET `category` = 'search' WHERE `id` = 'com.microsoft/microsoft-learn-mcp';
