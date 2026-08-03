-- Give every authenticated account a private, self-owned workspace.
-- Rows created while accounts were attached to another workspace remain with that
-- workspace because the legacy schema did not record the acting profile.
update profiles
set
  role = 'owner',
  workspace_owner_id = id,
  updated_at = now()
where auth_user_id is not null
  and (
    role <> 'owner'
    or workspace_owner_id <> id
  );

alter table profiles
  drop constraint if exists profiles_authenticated_self_workspace_check;
alter table profiles
  add constraint profiles_authenticated_self_workspace_check
  check (
    auth_user_id is null
    or (
      role = 'owner'
      and workspace_owner_id = id
    )
  );

-- Workspace sharing used to reassign a profile to another owner's data. Remove
-- that path until invitations and explicit membership records are implemented.
drop function if exists set_workspace_member_role(text, text);

-- Provider and feed identifiers are intentionally deterministic. Scope their
-- primary keys by owner so two users can save the same source or content item
-- without one service-role upsert moving the other user's row.
alter table interest_profiles
  drop constraint if exists interest_profiles_pkey;
alter table interest_profiles
  add constraint interest_profiles_pkey primary key (owner_id, id);

alter table sources
  drop constraint if exists sources_pkey;
alter table sources
  add constraint sources_pkey primary key (owner_id, id);

alter table content_items
  drop constraint if exists content_items_pkey;
alter table content_items
  add constraint content_items_pkey primary key (owner_id, id);

alter table collections
  drop constraint if exists collections_pkey;
alter table collections
  add constraint collections_pkey primary key (owner_id, id);

-- Collection membership also needs its owner's namespace now that collection
-- and content IDs may legitimately repeat across workspaces.
alter table collection_items
  add column if not exists owner_id text;

update collection_items as membership
set owner_id = collection.owner_id
from collections as collection
where membership.collection_id = collection.id
  and membership.owner_id is null;

do $$
begin
  if exists (
    select 1
    from collection_items
    where owner_id is null
  ) then
    raise exception 'Unable to determine an owner for every collection membership';
  end if;
end
$$;

alter table collection_items
  alter column owner_id set not null;
alter table collection_items
  drop constraint if exists collection_items_pkey;
alter table collection_items
  add constraint collection_items_pkey
  primary key (owner_id, collection_id, content_item_id);

drop policy if exists "collection_items_workspace_read" on collection_items;
create policy "collection_items_workspace_read"
on collection_items for select
to authenticated
using (
  collection_items.owner_id = current_workspace_owner_id()
  and exists (
    select 1
    from collections
    where collections.owner_id = collection_items.owner_id
      and collections.id = collection_items.collection_id
  )
);

-- Job IDs and idempotency keys only need to be unique inside one workspace.
alter table job_runs
  drop constraint if exists job_runs_idempotency_key_key;
alter table job_runs
  drop constraint if exists job_runs_pkey;
alter table job_runs
  add constraint job_runs_pkey primary key (owner_id, id);
alter table job_runs
  add constraint job_runs_owner_idempotency_key
  unique (owner_id, idempotency_key);

-- Draft audio is private. Published files remain streamable through the
-- application media route, which checks the episode status and workspace owner.
update storage.buckets
set public = false
where id = 'podcast-media';

alter table episodes
  add column if not exists citation_count integer not null default 0;

update episodes
set citation_count = jsonb_array_length(citations_json)
where jsonb_typeof(citations_json) = 'array'
  and citation_count <> jsonb_array_length(citations_json);

create index if not exists episodes_public_directory_idx
  on episodes (published_at desc)
  where status = 'published' and audio_key is not null;

drop index if exists episodes_audio_key_idx;
create unique index episodes_audio_key_idx
  on episodes (audio_key)
  where audio_key is not null;
