-- A single active local Chatterbox narrator per workspace. The reference recording
-- remains on the SignalCast host; this table stores only its opaque local file key.
create table if not exists voice_profiles (
  id text primary key,
  owner_id text not null unique,
  provider text not null default 'chatterbox',
  display_name text not null,
  sample_key text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voice_profiles_owner_idx on voice_profiles(owner_id);
alter table voice_profiles enable row level security;
