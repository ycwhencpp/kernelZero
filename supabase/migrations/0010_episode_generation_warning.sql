-- Keep non-fatal generation quality warnings attached to the draft that needs review.
alter table if exists episodes
  add column if not exists generation_warning text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'episodes_generation_warning_check'
  ) then
    alter table episodes
      add constraint episodes_generation_warning_check
      check (
        generation_warning is null
        or generation_warning = 'title_validation_failed'
      );
  end if;
end $$;

-- Keep the public citation URL stable while allowing a separate, rights-checked
-- open-access retrieval URL to be cached and extracted.
alter table if exists content_items
  add column if not exists document_url text;

-- Extracted documents are deliberately kept out of content_items so normal
-- dashboard reads never transfer large block payloads. Raw HTML and PDF bytes
-- are not persisted.
create table if not exists content_documents (
  owner_id text not null,
  content_item_id text not null,
  schema_version integer not null default 1,
  canonical_url text not null,
  retrieval_url text not null,
  resolved_url text not null,
  format text not null,
  status text not null,
  title text,
  byline text,
  language text,
  blocks_json jsonb not null default '[]'::jsonb,
  raw_bytes integer not null default 0,
  character_count integer not null default 0,
  page_count integer,
  truncated boolean not null default false,
  extractor text not null,
  extractor_version text not null,
  content_hash text,
  etag text,
  last_modified text,
  warnings_json jsonb not null default '[]'::jsonb,
  error_code text,
  fetched_at timestamptz not null default now(),
  retry_after timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, content_item_id),
  constraint content_documents_content_item_fk
    foreign key (owner_id, content_item_id)
    references content_items (owner_id, id)
    on delete cascade,
  constraint content_documents_schema_version_check
    check (schema_version = 1),
  constraint content_documents_format_check
    check (format in ('html', 'pdf', 'feed', 'abstract')),
  constraint content_documents_status_check
    check (status in ('ready', 'fallback', 'failed')),
  constraint content_documents_blocks_array_check
    check (jsonb_typeof(blocks_json) = 'array'),
  constraint content_documents_warnings_array_check
    check (jsonb_typeof(warnings_json) = 'array')
);

create index if not exists content_documents_owner_status_idx
  on content_documents (owner_id, status, fetched_at desc);

alter table content_documents enable row level security;

drop policy if exists "content_documents_workspace_read" on content_documents;
create policy "content_documents_workspace_read"
on content_documents for select
to authenticated
using (owner_id = current_workspace_owner_id());

drop policy if exists "content_documents_workspace_insert" on content_documents;
create policy "content_documents_workspace_insert"
on content_documents for insert
to authenticated
with check (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
);

drop policy if exists "content_documents_workspace_update" on content_documents;
create policy "content_documents_workspace_update"
on content_documents for update
to authenticated
using (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
)
with check (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
);

drop policy if exists "content_documents_workspace_delete" on content_documents;
create policy "content_documents_workspace_delete"
on content_documents for delete
to authenticated
using (
  owner_id = current_workspace_owner_id()
  and current_app_role() in ('owner', 'editor')
);
