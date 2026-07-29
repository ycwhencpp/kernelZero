-- Supabase Auth, workspace roles, and browser-safe RLS policies.
alter table profiles add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;
alter table profiles add column if not exists avatar_url text;
alter table profiles add column if not exists role text not null default 'owner';
alter table profiles add column if not exists workspace_owner_id text;

update profiles
set workspace_owner_id = id
where workspace_owner_id is null;

alter table profiles alter column workspace_owner_id set not null;

create or replace function default_profile_workspace_owner()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.workspace_owner_id is null or new.workspace_owner_id = '' then
    new.workspace_owner_id := new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_default_workspace_owner on profiles;
create trigger profiles_default_workspace_owner
before insert or update on profiles
for each row execute function default_profile_workspace_owner();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_role_check'
  ) then
    alter table profiles
      add constraint profiles_role_check
      check (role in ('owner', 'editor', 'viewer'));
  end if;
end $$;

create index if not exists profiles_auth_user_idx on profiles(auth_user_id);
create index if not exists profiles_workspace_owner_idx on profiles(workspace_owner_id);

create or replace function current_profile_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select id from profiles where auth_user_id = auth.uid() limit 1
$$;

create or replace function current_workspace_owner_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select workspace_owner_id from profiles where auth_user_id = auth.uid() limit 1
$$;

create or replace function current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where auth_user_id = auth.uid() limit 1
$$;

revoke all on function current_profile_id() from public;
revoke all on function current_workspace_owner_id() from public;
revoke all on function current_app_role() from public;
grant execute on function current_profile_id() to authenticated;
grant execute on function current_workspace_owner_id() to authenticated;
grant execute on function current_app_role() to authenticated;

drop policy if exists "profiles_read_own" on profiles;
create policy "profiles_read_own"
on profiles for select
to authenticated
using (auth_user_id = auth.uid());

-- The application writes through a service-role server client. These policies
-- also make future direct authenticated reads safe and workspace-scoped.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'interest_profiles',
    'sources',
    'content_items',
    'collections',
    'episodes',
    'feedback',
    'job_runs',
    'voice_profiles'
  ]
  loop
    execute format('drop policy if exists "workspace_read" on %I', table_name);
    execute format(
      'create policy "workspace_read" on %I for select to authenticated using (owner_id = current_workspace_owner_id())',
      table_name
    );
    execute format('drop policy if exists "workspace_editor_insert" on %I', table_name);
    execute format(
      'create policy "workspace_editor_insert" on %I for insert to authenticated with check (owner_id = current_workspace_owner_id() and current_app_role() in (''owner'', ''editor''))',
      table_name
    );
    if table_name <> 'episodes' then
      execute format('drop policy if exists "workspace_editor_update" on %I', table_name);
      execute format(
        'create policy "workspace_editor_update" on %I for update to authenticated using (owner_id = current_workspace_owner_id() and current_app_role() in (''owner'', ''editor'')) with check (owner_id = current_workspace_owner_id() and current_app_role() in (''owner'', ''editor''))',
        table_name
      );
      execute format('drop policy if exists "workspace_editor_delete" on %I', table_name);
      execute format(
        'create policy "workspace_editor_delete" on %I for delete to authenticated using (owner_id = current_workspace_owner_id() and current_app_role() in (''owner'', ''editor''))',
        table_name
      );
    end if;
  end loop;
end $$;

drop policy if exists "collection_items_workspace_read" on collection_items;
create policy "collection_items_workspace_read"
on collection_items for select
to authenticated
using (
  exists (
    select 1 from collections
    where collections.id = collection_items.collection_id
      and collections.owner_id = current_workspace_owner_id()
  )
);

drop policy if exists "evidence_workspace_read" on evidence;
create policy "evidence_workspace_read"
on evidence for select
to authenticated
using (
  exists (
    select 1 from episodes
    where episodes.id = evidence.episode_id
      and episodes.owner_id = current_workspace_owner_id()
  )
);

drop policy if exists "episodes_editor_update" on episodes;
create policy "episodes_editor_update"
on episodes for update
to authenticated
using (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
)
with check (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
  and (
    current_app_role() = 'owner'
    or status not in ('approved', 'published')
  )
);

drop policy if exists "episodes_owner_publish" on episodes;
create policy "episodes_owner_publish"
on episodes for update
to authenticated
using (
  owner_id = current_workspace_owner_id()
  and current_app_role() = 'owner'
)
with check (
  owner_id = current_workspace_owner_id()
  and current_app_role() = 'owner'
);

-- Owners can assign an existing Supabase Auth account to their workspace.
-- The member must sign in once first so an application profile exists.
create or replace function set_workspace_member_role(
  member_email text,
  member_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_app_role() <> 'owner' then
    raise exception 'Only a workspace owner can assign roles';
  end if;
  if member_role not in ('editor', 'viewer') then
    raise exception 'Member role must be editor or viewer';
  end if;

  update profiles
  set
    role = member_role,
    workspace_owner_id = current_workspace_owner_id(),
    updated_at = now()
  where lower(email) = lower(member_email)
    and role <> 'owner';

  if not found then
    raise exception 'That account must sign in once before a role can be assigned';
  end if;
end;
$$;

revoke all on function set_workspace_member_role(text, text) from public;
grant execute on function set_workspace_member_role(text, text) to authenticated;
