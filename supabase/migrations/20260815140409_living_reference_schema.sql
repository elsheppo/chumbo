create table public.reference_documents (
  slug text primary key,
  kind text not null check (kind in ('reference', 'pattern', 'example', 'troubleshooting')),
  title text not null,
  summary text not null,
  body_markdown text not null,
  source_path text not null unique,
  source_url text not null,
  package_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  content_hash text not null,
  updated_at timestamptz not null default now(),
  search_document tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' ||
      coalesce(body_markdown, '')
    )
  ) stored
);

create index reference_documents_search_idx
  on public.reference_documents using gin (search_document);
create index reference_documents_kind_idx
  on public.reference_documents (kind, slug);

alter table public.reference_documents enable row level security;
create policy "Reference documents are public"
  on public.reference_documents
  for select
  to anon, authenticated
  using (true);

grant select on public.reference_documents to anon, authenticated;
grant all on public.reference_documents to service_role;

create table public.demo_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'paused', 'complete')),
  created_at timestamptz not null default now()
);

create index demo_projects_owner_created_idx
  on public.demo_projects (owner_id, created_at desc);

alter table public.demo_projects enable row level security;
create policy "Users read their own demonstration projects"
  on public.demo_projects
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);
create policy "Users create their own demonstration projects"
  on public.demo_projects
  for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "Users update their own demonstration projects"
  on public.demo_projects
  for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy "Users delete their own demonstration projects"
  on public.demo_projects
  for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

grant select, insert, update, delete on public.demo_projects to authenticated;
grant all on public.demo_projects to service_role;

create table public.reference_servers (
  slug text primary key check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  instructions text not null,
  enabled boolean not null default true
);

create table public.reference_tools (
  server_slug text not null references public.reference_servers(slug) on delete cascade,
  name text not null check (name ~ '^[a-z][a-z0-9_]*$'),
  title text not null,
  description text not null,
  response jsonb not null,
  position integer not null default 1 check (position > 0),
  primary key (server_slug, name)
);

alter table public.reference_servers enable row level security;
alter table public.reference_tools enable row level security;
create policy "Reference MCP servers are public"
  on public.reference_servers
  for select
  to anon, authenticated
  using (enabled);
create policy "Reference MCP tools are public"
  on public.reference_tools
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.reference_servers
      where reference_servers.slug = reference_tools.server_slug
        and reference_servers.enabled
    )
  );

grant select on public.reference_servers, public.reference_tools
  to anon, authenticated;
grant all on public.reference_servers, public.reference_tools to service_role;

create schema if not exists private;

create table private.supa_mcp_rate_limits (
  key_hash text not null,
  bucket_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (key_hash, bucket_start)
);

create index supa_mcp_rate_limits_bucket_start_idx
  on private.supa_mcp_rate_limits (bucket_start);

revoke all on table private.supa_mcp_rate_limits from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete
  on table private.supa_mcp_rate_limits
  to service_role;

create or replace function public.supa_mcp_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  current_count integer,
  reset_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket_start timestamptz;
begin
  if p_key is null or p_key = '' then
    raise exception 'rate-limit key is required';
  end if;
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'rate-limit values must be positive';
  end if;

  v_bucket_start := to_timestamp(
    floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds
  );

  insert into private.supa_mcp_rate_limits (
    key_hash,
    bucket_start,
    request_count
  )
  values (p_key, v_bucket_start, 1)
  on conflict (key_hash, bucket_start)
  do update set request_count =
    private.supa_mcp_rate_limits.request_count + 1
  returning request_count into current_count;

  allowed := current_count <= p_limit;
  reset_at := v_bucket_start + make_interval(secs => p_window_seconds);

  if random() < 0.01 then
    delete from private.supa_mcp_rate_limits
    where bucket_start < v_now - interval '1 day';
  end if;

  return next;
end;
$$;

revoke all on function public.supa_mcp_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.supa_mcp_rate_limit(text, integer, integer)
  to service_role;
