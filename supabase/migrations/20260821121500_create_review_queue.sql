create table public.review_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 120),
  summary text not null check (char_length(trim(summary)) between 1 and 500),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint review_items_decision_time check (
    (status = 'pending' and decided_at is null)
    or (status in ('approved', 'rejected') and decided_at is not null)
  )
);

create index review_items_owner_status_created_idx
  on public.review_items (owner_id, status, created_at desc);

alter table public.review_items enable row level security;

create policy "Users read their own review items"
  on public.review_items
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Users decide their own review items"
  on public.review_items
  for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

grant select, update on public.review_items to authenticated;
grant all on public.review_items to service_role;

comment on table public.review_items is
  'Living-reference data for the authenticated MCP Apps review-queue pattern.';
