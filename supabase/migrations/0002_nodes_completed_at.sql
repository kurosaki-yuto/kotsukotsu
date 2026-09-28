alter table public.nodes
  add column if not exists completed_at timestamptz;

create index if not exists nodes_completed_at_idx
  on public.nodes (completed_at);
