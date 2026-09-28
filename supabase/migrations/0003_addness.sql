-- 0003 addness clone: goals metadata, members, notifications, chat, resources, org settings.
-- projects == goals, nodes == subtasks (reused). anon full RW (URL-only model).

-- ---- goals (projects) extra columns ----
alter table public.projects add column if not exists emoji text;
alter table public.projects add column if not exists deadline date;
alter table public.projects add column if not exists current_state text;
alter table public.projects add column if not exists completion_criteria text;
alter table public.projects add column if not exists owner text default '黒崎優斗';
alter table public.projects add column if not exists status text not null default 'active';
alter table public.projects add column if not exists archived_at timestamptz;
alter table public.projects add column if not exists parent_goal_id uuid references public.projects(id) on delete cascade;

-- ---- subtasks (nodes) extra columns ----
alter table public.nodes add column if not exists today_date date;     -- selected as 今日のToDo for this date
alter table public.nodes add column if not exists estimate_min int;     -- 見積り(分)

-- ---- org settings (singleton) ----
create table if not exists public.org_settings (
  id int primary key default 1,
  name text not null default '黒崎優斗のワークスペース',
  timezone text not null default 'Asia/Tokyo',
  logo_url text,
  updated_at timestamptz not null default now(),
  constraint org_settings_singleton check (id = 1)
);
insert into public.org_settings (id) values (1) on conflict (id) do nothing;

-- ---- members ----
create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null default 'Admin',     -- Admin / None
  is_ai boolean not null default false,
  is_you boolean not null default false,
  email text,
  avatar text,
  points int not null default 0,
  streak int not null default 0,
  joined_at timestamptz not null default now()
);
insert into public.members (name, role, is_you, avatar)
  select '黒崎優斗', 'Admin', true, null
  where not exists (select 1 from public.members where is_you = true);
insert into public.members (name, role, is_ai, avatar)
  select 'Addy', 'None', true, null
  where not exists (select 1 from public.members where is_ai = true);

-- ---- notifications ----
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'info',       -- info / mention / goal / streak / addy
  title text not null,
  body text,
  goal_id uuid references public.projects(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_created_idx on public.notifications (created_at desc);

-- ---- chat messages (per-goal threads) ----
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references public.projects(id) on delete cascade,
  scope text not null default 'goal',      -- goal / today
  role text not null default 'user',       -- user / addy / system
  author text,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_goal_idx on public.chat_messages (goal_id, created_at);

-- ---- resources (goal deliverables / files / notes) ----
create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid references public.projects(id) on delete cascade,
  name text not null,
  kind text not null default 'note',       -- note / file / link / doc
  url text,
  content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists resources_goal_idx on public.resources (goal_id, updated_at desc);

-- updated_at triggers (reuse set_updated_at from 0001)
drop trigger if exists resources_set_updated_at on public.resources;
create trigger resources_set_updated_at before update on public.resources
  for each row execute function set_updated_at();
drop trigger if exists org_settings_set_updated_at on public.org_settings;
create trigger org_settings_set_updated_at before update on public.org_settings
  for each row execute function set_updated_at();

-- ---- realtime ----
do $$ begin
  begin alter publication supabase_realtime add table public.members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.chat_messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.resources; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.org_settings; exception when duplicate_object then null; end;
end $$;

-- ---- RLS: anon full RW ----
alter table public.org_settings  enable row level security;
alter table public.members       enable row level security;
alter table public.notifications enable row level security;
alter table public.chat_messages enable row level security;
alter table public.resources     enable row level security;

drop policy if exists anon_all on public.org_settings;
drop policy if exists anon_all on public.members;
drop policy if exists anon_all on public.notifications;
drop policy if exists anon_all on public.chat_messages;
drop policy if exists anon_all on public.resources;

create policy anon_all on public.org_settings  for all to anon, authenticated using (true) with check (true);
create policy anon_all on public.members       for all to anon, authenticated using (true) with check (true);
create policy anon_all on public.notifications for all to anon, authenticated using (true) with check (true);
create policy anon_all on public.chat_messages for all to anon, authenticated using (true) with check (true);
create policy anon_all on public.resources     for all to anon, authenticated using (true) with check (true);
