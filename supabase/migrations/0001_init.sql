-- todo-app initial schema
-- Public outliner store. anon key has full RW (URL-only access model).

create extension if not exists "pgcrypto";

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  order_idx int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists nodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  parent_id uuid references nodes(id) on delete cascade,
  text text not null default '',
  order_idx int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists nodes_project_parent_order_idx
  on nodes (project_id, parent_id, order_idx);

create table if not exists done_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  project_name text,
  text text not null,
  sub_md text,
  completed_at timestamptz not null default now()
);
create index if not exists done_log_completed_at_idx
  on done_log (completed_at desc);

-- updated_at trigger
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists nodes_set_updated_at on nodes;
create trigger nodes_set_updated_at
  before update on nodes
  for each row execute function set_updated_at();

-- Realtime publication
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter publication supabase_realtime add table projects;
alter publication supabase_realtime add table nodes;
alter publication supabase_realtime add table done_log;

-- RLS: anon has full RW (URL-only access — no auth)
alter table projects enable row level security;
alter table nodes    enable row level security;
alter table done_log enable row level security;

drop policy if exists anon_all on projects;
drop policy if exists anon_all on nodes;
drop policy if exists anon_all on done_log;

create policy anon_all on projects
  for all to anon, authenticated using (true) with check (true);
create policy anon_all on nodes
  for all to anon, authenticated using (true) with check (true);
create policy anon_all on done_log
  for all to anon, authenticated using (true) with check (true);
