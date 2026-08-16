-- Distinguish recoverable provider titles from Gemini-finalized and edited titles.
alter table if exists episodes
  add column if not exists title_provenance text not null default 'manual';

alter table if exists episodes
  drop constraint if exists episodes_title_provenance_check;

alter table if exists episodes
  add constraint episodes_title_provenance_check
  check (title_provenance in ('provisional', 'gemini', 'manual'));
