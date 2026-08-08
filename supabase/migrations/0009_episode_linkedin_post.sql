-- Retain the latest generated LinkedIn post with its source episode.
alter table if exists episodes
  add column if not exists linkedin_post text;
