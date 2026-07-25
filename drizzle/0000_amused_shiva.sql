CREATE TABLE `collection_items` (
	`collection_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#b9ef65' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`authors_json` text DEFAULT '[]' NOT NULL,
	`source_name` text NOT NULL,
	`source_id` text,
	`canonical_url` text NOT NULL,
	`doi` text,
	`arxiv_id` text,
	`published_at` text NOT NULL,
	`access_level` text DEFAULT 'abstract_only' NOT NULL,
	`peer_review_state` text DEFAULT 'unknown' NOT NULL,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`score` real DEFAULT 0 NOT NULL,
	`trend` text DEFAULT 'latest' NOT NULL,
	`citation_count` integer DEFAULT 0 NOT NULL,
	`reading_minutes` integer DEFAULT 8 NOT NULL,
	`saved` integer DEFAULT false NOT NULL,
	`listened` integer DEFAULT false NOT NULL,
	`processing_state` text DEFAULT 'ready' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`content_item_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`dek` text DEFAULT '' NOT NULL,
	`script` text NOT NULL,
	`show_notes` text DEFAULT '' NOT NULL,
	`transcript` text DEFAULT '' NOT NULL,
	`citations_json` text DEFAULT '[]' NOT NULL,
	`chapters_json` text DEFAULT '[]' NOT NULL,
	`audio_url` text,
	`audio_key` text,
	`audio_bytes` integer,
	`duration_seconds` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'needs_approval' NOT NULL,
	`published_at` text,
	`immutable_guid` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`claim` text NOT NULL,
	`support` text NOT NULL,
	`source_url` text NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`location` text DEFAULT 'abstract' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`action` text NOT NULL,
	`value` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `interest_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`query` text NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`exclusions_json` text DEFAULT '[]' NOT NULL,
	`preferred_sources_json` text DEFAULT '[]' NOT NULL,
	`freshness_days` integer DEFAULT 30 NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`provider` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`error` text,
	`idempotency_key` text NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_idempotency_key_unique` ON `job_runs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Kolkata' NOT NULL,
	`daily_budget_usd` real DEFAULT 2 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_email_unique` ON `profiles` (`email`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`trust_level` text DEFAULT 'trusted' NOT NULL,
	`rights_mode` text DEFAULT 'feed_only' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_successful_fetch` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
