-- ══════════════════════════════════════════════════════════════
-- TAMRO — Web Push setup
-- Run this once in Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════════════

create table if not exists dboy_push_subs (
  dboy_name text primary key,
  subscription jsonb not null,
  updated_at timestamptz default now()
);

alter table dboy_push_subs enable row level security;

-- Same open-access pattern already used by dboy_locations in this app
-- (the app has no auth layer, it uses the public anon key directly)
create policy "public_all" on dboy_push_subs
  for all using (true) with check (true);
