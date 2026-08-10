-- Retain one durable recording per episode/narrator while keeping episodes.audio_*
-- as the backwards-compatible projection used by feeds and older clients.

alter table episodes
  add column if not exists default_audio_variant_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'episodes_owner_id_key'
  ) then
    alter table episodes
      add constraint episodes_owner_id_key unique (owner_id, id);
  end if;
end
$$;

create table if not exists episode_audio_variants (
  id text primary key,
  owner_id text not null,
  episode_id text not null,
  voice_profile_id text references voice_profiles(id) on delete set null,
  voice_key text not null,
  voice_name text not null,
  provider text not null,
  audio_key text not null unique,
  audio_bytes integer,
  content_type text not null default 'audio/mpeg',
  duration_seconds integer not null default 0,
  chapters_json jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint episode_audio_variants_audio_bytes_check
    check (audio_bytes is null or audio_bytes >= 0),
  constraint episode_audio_variants_duration_check
    check (duration_seconds >= 0),
  constraint episode_audio_variants_episode_voice_key
    unique (owner_id, episode_id, voice_key),
  constraint episode_audio_variants_owner_episode_id_key
    unique (owner_id, episode_id, id),
  constraint episode_audio_variants_episode_fk
    foreign key (owner_id, episode_id)
    references episodes(owner_id, id)
    on delete cascade
);

create index if not exists episode_audio_variants_owner_episode_idx
  on episode_audio_variants(owner_id, episode_id, created_at);

-- The previous schema cannot reliably identify which historical voice produced an
-- existing object. Preserve it without incorrectly attributing it to today's
-- active profile.
insert into episode_audio_variants (
  id,
  owner_id,
  episode_id,
  voice_profile_id,
  voice_key,
  voice_name,
  provider,
  audio_key,
  audio_bytes,
  content_type,
  duration_seconds,
  chapters_json,
  created_at,
  updated_at
)
select
  'audio-variant-legacy-' || md5(episode.owner_id || ':' || episode.id || ':' || episode.audio_key),
  episode.owner_id,
  episode.id,
  null,
  'legacy:' || md5(episode.audio_key),
  'Original audio',
  'legacy',
  episode.audio_key,
  episode.audio_bytes,
  case
    when lower(episode.audio_key) like '%.wav' then 'audio/wav'
    else 'audio/mpeg'
  end,
  greatest(0, episode.duration_seconds),
  episode.chapters_json,
  episode.created_at,
  episode.updated_at
from episodes as episode
where episode.audio_key is not null
on conflict (owner_id, episode_id, voice_key) do nothing;

update episodes as episode
set default_audio_variant_id = variant.id
from episode_audio_variants as variant
where episode.default_audio_variant_id is null
  and variant.owner_id = episode.owner_id
  and variant.episode_id = episode.id
  and variant.audio_key = episode.audio_key;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'episodes_default_audio_variant_fk'
  ) then
    alter table episodes
      add constraint episodes_default_audio_variant_fk
      foreign key (owner_id, id, default_audio_variant_id)
      references episode_audio_variants(owner_id, episode_id, id)
      deferrable initially deferred;
  end if;
end
$$;

alter table episode_audio_variants enable row level security;

drop policy if exists "workspace_read" on episode_audio_variants;
create policy "workspace_read"
on episode_audio_variants for select
to authenticated
using (owner_id = current_workspace_owner_id());

drop policy if exists "workspace_editor_insert" on episode_audio_variants;
create policy "workspace_editor_insert"
on episode_audio_variants for insert
to authenticated
with check (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
);

drop policy if exists "workspace_editor_update" on episode_audio_variants;
create policy "workspace_editor_update"
on episode_audio_variants for update
to authenticated
using (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
)
with check (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
);

drop policy if exists "workspace_editor_delete" on episode_audio_variants;
create policy "workspace_editor_delete"
on episode_audio_variants for delete
to authenticated
using (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
);
