PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_collection_items` (
	`collection_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`collection_id`, `content_item_id`)
);
--> statement-breakpoint
INSERT INTO `__new_collection_items`("collection_id", "content_item_id", "created_at") SELECT "collection_id", "content_item_id", "created_at" FROM `collection_items`;--> statement-breakpoint
DROP TABLE `collection_items`;--> statement-breakpoint
ALTER TABLE `__new_collection_items` RENAME TO `collection_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `content_owner_score_idx` ON `content_items` (`owner_id`,`score`);--> statement-breakpoint
CREATE INDEX `content_owner_published_idx` ON `content_items` (`owner_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `episodes_owner_status_idx` ON `episodes` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `evidence_episode_idx` ON `evidence` (`episode_id`);--> statement-breakpoint
CREATE INDEX `feedback_owner_item_idx` ON `feedback` (`owner_id`,`content_item_id`);--> statement-breakpoint
CREATE INDEX `interests_owner_idx` ON `interest_profiles` (`owner_id`);--> statement-breakpoint
CREATE INDEX `sources_owner_idx` ON `sources` (`owner_id`);