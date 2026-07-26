-- Upgrade installations that previously applied the provider-hosted voice schema.
-- Existing provider IDs cannot be used locally, so their rows remain available for
-- manual removal but are ignored until the user uploads a local reference sample.
alter table if exists voice_profiles add column if not exists sample_key text;
alter table if exists voice_profiles drop column if exists voice_id;
alter table if exists voice_profiles drop column if exists consent_id;
alter table if exists voice_profiles alter column provider set default 'chatterbox';
