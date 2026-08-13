create schema if not exists private;

create table if not exists private.supa_mcp_rate_limits (
  key_hash text not null,
  bucket_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (key_hash, bucket_start)
);

create index if not exists supa_mcp_rate_limits_bucket_start_idx
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
