-- Team Tasks: the application schema shared by the web app and the MCP server.
-- Row Level Security is the authorization boundary for both. Nothing in the
-- MCP Edge Function bypasses it.

create schema if not exists private;

create type public.team_role as enum ('owner', 'member');
create type public.task_status as enum ('todo', 'doing', 'done');

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.team_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index team_members_user_id_idx on public.team_members (user_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  status public.task_status not null default 'todo',
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_team_id_id_idx on public.tasks (team_id, id);

-- Membership check used by every policy. SECURITY DEFINER avoids recursive
-- evaluation of team_members policies; the private schema is not exposed
-- through the Data API.
create function private.is_team_member(target_team uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members
    where team_id = target_team
      and user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_team_member(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_team_member(uuid) to authenticated;

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.tasks enable row level security;

revoke all on public.teams, public.team_members, public.tasks from anon;
revoke all on public.teams, public.team_members, public.tasks from authenticated;
grant select on public.teams, public.team_members to authenticated;
grant select, insert on public.tasks to authenticated;
grant update (title, status) on public.tasks to authenticated;
grant delete on public.tasks to authenticated;

create policy "Members read their teams"
  on public.teams for select to authenticated
  using ((select private.is_team_member(id)));

create policy "Members read their teams' memberships"
  on public.team_members for select to authenticated
  using ((select private.is_team_member(team_id)));

create policy "Members read team tasks"
  on public.tasks for select to authenticated
  using ((select private.is_team_member(team_id)));

create policy "Members create tasks as themselves"
  on public.tasks for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.is_team_member(team_id))
  );

create policy "Members update team tasks"
  on public.tasks for update to authenticated
  using ((select private.is_team_member(team_id)))
  with check ((select private.is_team_member(team_id)));

create policy "Creators delete their own tasks"
  on public.tasks for delete to authenticated
  using (
    created_by = (select auth.uid())
    and (select private.is_team_member(team_id))
  );

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function private.touch_updated_at();

-- Create a team and make the caller its owner in one statement.
create function public.create_team(team_name text)
returns public.teams
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  created public.teams;
begin
  if caller is null then
    raise exception 'Sign in to create a team' using errcode = '42501';
  end if;
  insert into public.teams (name) values (team_name) returning * into created;
  insert into public.team_members (team_id, user_id, role)
    values (created.id, caller, 'owner');
  return created;
end;
$$;

revoke all on function public.create_team(text) from public, anon;
grant execute on function public.create_team(text) to authenticated;
