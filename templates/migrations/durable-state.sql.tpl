create schema if not exists private;

create table if not exists private.supa_mcp_state (
  namespace text not null,
  caller_key text not null,
  object_key text not null,
  value jsonb not null,
  value_bytes integer not null,
  revision bigint not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (namespace, caller_key, object_key),
  constraint supa_mcp_state_namespace_check check (
    octet_length(namespace) between 1 and 64
    and namespace ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
  ),
  constraint supa_mcp_state_caller_key_check check (
    caller_key ~ '^[0-9a-f]{64}$'
  ),
  constraint supa_mcp_state_object_key_check check (
    octet_length(object_key) between 1 and 512
    and object_key = btrim(object_key)
    and object_key !~ '[[:cntrl:]]'
  ),
  constraint supa_mcp_state_value_bytes_check check (
    value_bytes between 1 and 65536
  ),
  constraint supa_mcp_state_revision_check check (
    revision between 1 and 9007199254740991
  )
);

create index if not exists supa_mcp_state_expires_at_idx
  on private.supa_mcp_state (expires_at);

alter table private.supa_mcp_state enable row level security;
revoke all on table private.supa_mcp_state
  from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete
  on table private.supa_mcp_state
  to service_role;

create or replace function public.supa_mcp_state_get(
  p_namespace text,
  p_caller_key text,
  p_object_key text
)
returns table (
  status text,
  value_text text,
  revision bigint,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_namespace is null
    or octet_length(p_namespace) not between 1 and 64
    or p_namespace !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
    or p_caller_key is null
    or p_caller_key !~ '^[0-9a-f]{64}$'
    or p_object_key is null
    or octet_length(p_object_key) not between 1 and 512
    or p_object_key <> btrim(p_object_key)
    or p_object_key ~ '[[:cntrl:]]'
  then
    raise exception 'invalid durable state locator';
  end if;

  delete from private.supa_mcp_state as state
  where state.namespace = p_namespace
    and state.caller_key = p_caller_key
    and state.object_key = p_object_key
    and state.expires_at <= v_now;

  return query
    select
      'found'::text,
      state.value::text,
      state.revision,
      state.expires_at
    from private.supa_mcp_state as state
    where state.namespace = p_namespace
      and state.caller_key = p_caller_key
      and state.object_key = p_object_key
      and state.expires_at > v_now;
end;
$$;

create or replace function public.supa_mcp_state_put(
  p_namespace text,
  p_caller_key text,
  p_object_key text,
  p_value_text text,
  p_expected_revision bigint,
  p_ttl_seconds integer
)
returns table (
  status text,
  revision bigint,
  expires_at timestamptz,
  reclaimed_count integer
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_value jsonb;
  v_value_bytes integer;
begin
  if p_namespace is null
    or octet_length(p_namespace) not between 1 and 64
    or p_namespace !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
    or p_caller_key is null
    or p_caller_key !~ '^[0-9a-f]{64}$'
    or p_object_key is null
    or octet_length(p_object_key) not between 1 and 512
    or p_object_key <> btrim(p_object_key)
    or p_object_key ~ '[[:cntrl:]]'
  then
    raise exception 'invalid durable state locator';
  end if;
  if p_value_text is null
    or octet_length(p_value_text) not between 1 and 65536
  then
    raise exception 'invalid durable state value size';
  end if;
  if p_expected_revision is not null
    and p_expected_revision not between 1 and 9007199254740991
  then
    raise exception 'invalid durable state revision';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 1 and 2592000 then
    raise exception 'invalid durable state ttl';
  end if;

  v_value := p_value_text::jsonb;
  v_value_bytes := octet_length(v_value::text);
  if v_value_bytes not between 1 and 65536 then
    raise exception 'invalid durable state value size';
  end if;

  -- Credential rotation intentionally makes old caller partitions
  -- unreachable. Reclaim a small, index-backed batch during ordinary writes
  -- so expired rows cannot accumulate without lengthening this transaction
  -- beyond 16 row locks/deletes. SKIP LOCKED lets concurrent writers help.
  with expired as materialized (
    select state.ctid
    from private.supa_mcp_state as state
    where state.expires_at <= v_now
    order by state.expires_at
    limit 16
    for update skip locked
  )
  delete from private.supa_mcp_state as state
  using expired
  where state.ctid = expired.ctid;
  get diagnostics reclaimed_count = row_count;

  if p_expected_revision is null then
    insert into private.supa_mcp_state as state (
      namespace,
      caller_key,
      object_key,
      value,
      value_bytes,
      revision,
      expires_at,
      updated_at
    ) values (
      p_namespace,
      p_caller_key,
      p_object_key,
      v_value,
      v_value_bytes,
      1,
      v_now + make_interval(secs => p_ttl_seconds),
      v_now
    )
    on conflict (namespace, caller_key, object_key)
    do update set
      value = excluded.value,
      value_bytes = excluded.value_bytes,
      revision = 1,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    where state.expires_at <= v_now
    returning state.revision, state.expires_at
      into revision, expires_at;

    if found then
      status := 'written';
      return next;
      return;
    end if;

    select state.revision
      into revision
    from private.supa_mcp_state as state
    where state.namespace = p_namespace
      and state.caller_key = p_caller_key
      and state.object_key = p_object_key
      and state.expires_at > v_now;
    status := 'conflict';
    expires_at := null;
    return next;
    return;
  end if;

  update private.supa_mcp_state as state
  set
    value = v_value,
    value_bytes = v_value_bytes,
    revision = state.revision + 1,
    expires_at = v_now + make_interval(secs => p_ttl_seconds),
    updated_at = v_now
  where state.namespace = p_namespace
    and state.caller_key = p_caller_key
    and state.object_key = p_object_key
    and state.expires_at > v_now
    and state.revision = p_expected_revision
    and state.revision < 9007199254740991
  returning state.revision, state.expires_at
    into revision, expires_at;

  if found then
    status := 'written';
    return next;
    return;
  end if;

  select state.revision
    into revision
  from private.supa_mcp_state as state
  where state.namespace = p_namespace
    and state.caller_key = p_caller_key
    and state.object_key = p_object_key
    and state.expires_at > v_now;
  status := case when found then 'conflict' else 'missing' end;
  expires_at := null;
  return next;
end;
$$;

create or replace function public.supa_mcp_state_delete(
  p_namespace text,
  p_caller_key text,
  p_object_key text,
  p_expected_revision bigint
)
returns table (
  status text,
  revision bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_namespace is null
    or octet_length(p_namespace) not between 1 and 64
    or p_namespace !~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
    or p_caller_key is null
    or p_caller_key !~ '^[0-9a-f]{64}$'
    or p_object_key is null
    or octet_length(p_object_key) not between 1 and 512
    or p_object_key <> btrim(p_object_key)
    or p_object_key ~ '[[:cntrl:]]'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
  then
    raise exception 'invalid durable state delete';
  end if;

  delete from private.supa_mcp_state as state
  where state.namespace = p_namespace
    and state.caller_key = p_caller_key
    and state.object_key = p_object_key
    and state.expires_at > clock_timestamp()
    and state.revision = p_expected_revision
  returning p_expected_revision into revision;

  if found then
    status := 'deleted';
    return next;
    return;
  end if;

  select state.revision
    into revision
  from private.supa_mcp_state as state
  where state.namespace = p_namespace
    and state.caller_key = p_caller_key
    and state.object_key = p_object_key
    and state.expires_at > clock_timestamp();
  status := case when found then 'conflict' else 'missing' end;
  return next;
end;
$$;

revoke all on function public.supa_mcp_state_get(text, text, text)
  from public, anon, authenticated;
revoke all on function public.supa_mcp_state_put(
  text, text, text, text, bigint, integer
) from public, anon, authenticated;
revoke all on function public.supa_mcp_state_delete(text, text, text, bigint)
  from public, anon, authenticated;

grant execute on function public.supa_mcp_state_get(text, text, text)
  to service_role;
grant execute on function public.supa_mcp_state_put(
  text, text, text, text, bigint, integer
) to service_role;
grant execute on function public.supa_mcp_state_delete(text, text, text, bigint)
  to service_role;
