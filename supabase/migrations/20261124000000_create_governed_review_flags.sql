-- Reference schema for the governed review pattern:
-- Contributor `flag_for_review` -> Admin `ui://` Review Queue MCP App.
--
-- This schema is intentionally unopinionated: real applications bind
-- `review_flags` to their own tenant/workspace membership tables and target
-- record tables while keeping the same RLS invariants:
--   1. Contributors can flag only records they are already authorized to read
--      (preventing blind existence probing across workspaces).
--   2. Contributors can read only flags they created; workspace admins can
--      read and decide (resolve/dismiss) flags for their workspace.
--   3. Idempotent `flag_request_id` / `decision_request_id` columns and
--      monotone `revision` prevent duplicate flags and stale admin decisions.
--   4. Explicit `GRANT`s keep the Data API working on Supabase projects
--      created after 2026-10-30 without granting `DELETE`.

create table if not exists public.reference_workspace_members (
  workspace_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('contributor', 'admin')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists reference_workspace_members_user_idx
  on public.reference_workspace_members (user_id, workspace_id, role);

create table if not exists public.reference_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  title text not null,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists reference_records_workspace_idx
  on public.reference_records (workspace_id, updated_at desc);

create table if not exists public.review_flags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  record_id uuid not null references public.reference_records (id) on delete cascade,
  flagged_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  flag_request_id text not null,
  reason text not null check (
    reason in ('inaccurate', 'outdated', 'sensitive', 'duplicate', 'other')
  ),
  note text not null default '' check (char_length(note) <= 2000),
  status text not null default 'open' check (
    status in ('open', 'resolved', 'dismissed')
  ),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '' check (char_length(decision_note) <= 2000),
  decision_request_id text,
  revision integer not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flagged_by, flag_request_id)
);

create index if not exists review_flags_workspace_status_idx
  on public.review_flags (workspace_id, status, created_at desc);

create index if not exists review_flags_record_idx
  on public.review_flags (record_id, status);

alter table public.reference_workspace_members enable row level security;
alter table public.reference_records enable row level security;
alter table public.review_flags enable row level security;

-- Workspace membership: users see only their own memberships.
drop policy if exists reference_workspace_members_select_self
  on public.reference_workspace_members;
create policy reference_workspace_members_select_self
  on public.reference_workspace_members
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Reference records: workspace members read only records in their workspace.
drop policy if exists reference_records_select_member
  on public.reference_records;
create policy reference_records_select_member
  on public.reference_records
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.reference_workspace_members m
      where m.workspace_id = reference_records.workspace_id
        and m.user_id = (select auth.uid())
    )
  );

-- Contributor insert: caller can flag only a record in a workspace they belong to,
-- and only as `flagged_by = auth.uid()` in the initial `open` state.
drop policy if exists review_flags_insert_contributor
  on public.review_flags;
create policy review_flags_insert_contributor
  on public.review_flags
  for insert
  to authenticated
  with check (
    flagged_by = (select auth.uid())
    and status = 'open'
    and decided_by is null
    and decided_at is null
    and exists (
      select 1
      from public.reference_records r
      join public.reference_workspace_members m
        on m.workspace_id = r.workspace_id
      where r.id = review_flags.record_id
        and r.workspace_id = review_flags.workspace_id
        and m.user_id = (select auth.uid())
    )
  );

-- Contributor read: caller sees only flags they submitted.
drop policy if exists review_flags_select_own
  on public.review_flags;
create policy review_flags_select_own
  on public.review_flags
  for select
  to authenticated
  using (flagged_by = (select auth.uid()));

-- Admin read: workspace admins see all flags for their workspace.
drop policy if exists review_flags_select_admin
  on public.review_flags;
create policy review_flags_select_admin
  on public.review_flags
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.reference_workspace_members m
      where m.workspace_id = review_flags.workspace_id
        and m.user_id = (select auth.uid())
        and m.role = 'admin'
    )
  );

-- Admin decision update: workspace admins can resolve or dismiss flags in their
-- workspace while keeping `flagged_by`, `record_id`, and `workspace_id` bound
-- to their workspace and setting `decided_by = auth.uid()`.
drop policy if exists review_flags_update_admin
  on public.review_flags;
create policy review_flags_update_admin
  on public.review_flags
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.reference_workspace_members m
      where m.workspace_id = review_flags.workspace_id
        and m.user_id = (select auth.uid())
        and m.role = 'admin'
    )
  )
  with check (
    decided_by = (select auth.uid())
    and status in ('resolved', 'dismissed')
    and exists (
      select 1
      from public.reference_workspace_members m
      where m.workspace_id = review_flags.workspace_id
        and m.user_id = (select auth.uid())
        and m.role = 'admin'
    )
  );

-- Explicit post-2026-10-30 Data API grants (authenticated only; no DELETE).
grant usage on schema public to authenticated;
grant select on public.reference_workspace_members to authenticated;
grant select on public.reference_records to authenticated;
grant select, insert, update on public.review_flags to authenticated;
