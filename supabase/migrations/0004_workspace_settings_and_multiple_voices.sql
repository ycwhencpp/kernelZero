-- Persist automation preferences and allow a workspace to retain multiple local narrators.
alter table if exists profiles add column if not exists daily_generation_enabled boolean not null default true;
alter table if exists profiles add column if not exists episode_length text not null default 'standard';
alter table if exists profiles add column if not exists publish_time text not null default '08:00';

alter table if exists voice_profiles drop constraint if exists voice_profiles_owner_id_key;
drop index if exists voice_profiles_owner_id_key;
create unique index if not exists voice_profiles_one_active_per_owner_idx
  on voice_profiles(owner_id)
  where active;
