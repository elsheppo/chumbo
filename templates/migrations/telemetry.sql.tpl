do $$
declare
  existing_v1_digest text;
  existing_v2_digest text;
begin
  if exists (select 1 from pg_namespace where nspname = 'chumbo_telemetry') then
    if to_regclass('chumbo_telemetry.installation_artifacts') is null then
      raise exception 'Unrecognized pre-existing chumbo_telemetry namespace';
    end if;
    execute $query$select artifact_digest from chumbo_telemetry.installation_artifacts
      where artifact_id = 'chumbo-telemetry@2'$query$
      into existing_v2_digest;
    execute $query$select artifact_digest from chumbo_telemetry.installation_artifacts
      where artifact_id = 'chumbo-telemetry@1'$query$
      into existing_v1_digest;
    if existing_v2_digest is not null then
      if existing_v2_digest is distinct from 'sha256:bc2a1697324b0b7f45ccfd9b1e3bb8fb09ab7e4c7632aa3de6aeca320661ed49' then
        raise exception 'Chumbo telemetry artifact lineage mismatch';
      end if;
    elsif existing_v1_digest is distinct from 'sha256:4df17324f34ce179b21ade5e319d84f814d6904d780571978786f99960a9010d' then
      raise exception 'Chumbo telemetry artifact lineage mismatch';
    end if;
  elsif exists (
    select 1
    from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'public'
      and pg_proc.proname in (
        'chumbo_telemetry_consume_nonce',
        'chumbo_telemetry_ingest',
        'chumbo_telemetry_ingest_v2',
        'chumbo_analytics_aggregate',
        'chumbo_insights_aggregate',
        'chumbo_insights_people',
        'chumbo_insights_runs'
      )
  ) then
    raise exception 'Unrecognized pre-existing Chumbo telemetry RPC';
  end if;
end;
$$;

create schema if not exists chumbo_telemetry;
revoke all on schema chumbo_telemetry from public, anon, authenticated;
grant usage on schema chumbo_telemetry to service_role;

create table if not exists chumbo_telemetry.capability_events (
  id bigint generated always as identity primary key,
  installation_id text not null check (char_length(installation_id) between 1 and 128),
  surface_id text not null check (char_length(surface_id) between 1 and 128),
  event_type text not null check (event_type in ('capability.started', 'capability.finished')),
  occurred_at timestamptz not null,
  trace_id text not null check (char_length(trace_id) between 1 and 256),
  event_fingerprint text not null check (event_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  server_name text not null check (char_length(server_name) between 1 and 128),
  server_version text not null check (char_length(server_version) between 1 and 128),
  capability_kind text not null check (capability_kind in ('tool', 'resource', 'prompt')),
  capability_name text not null check (char_length(capability_name) between 1 and 128),
  actor_hash text check (actor_hash is null or actor_hash ~ '^[A-Za-z0-9_-]{43}$'),
  client_hash text check (client_hash is null or client_hash ~ '^[A-Za-z0-9_-]{43}$'),
  subject text check (subject is null or char_length(subject) between 1 and 128),
  client_id text check (client_id is null or char_length(client_id) between 1 and 128),
  authentication_mode text not null check (authentication_mode in ('oauth', 'bearer', 'api-key', 'public')),
  authentication_strategy text not null check (char_length(authentication_strategy) between 1 and 128),
  run_id text check (run_id is null or run_id ~ '^run_[A-Za-z0-9_-]{8,86}$'),
  run_started_at timestamptz,
  session_id text check (session_id is null or char_length(session_id) between 1 and 128),
  run_rejected text check (run_rejected is null or run_rejected ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  error_code text check (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 86400000),
  outcome text check (outcome is null or outcome in ('success', 'tool-error', 'input-required', 'failure')),
  received_at timestamptz not null default now(),
  unique (installation_id, surface_id, event_fingerprint)
);

alter table chumbo_telemetry.capability_events
  add column if not exists subject text check (subject is null or char_length(subject) between 1 and 128),
  add column if not exists client_id text check (client_id is null or char_length(client_id) between 1 and 128),
  add column if not exists run_started_at timestamptz,
  add column if not exists session_id text check (session_id is null or char_length(session_id) between 1 and 128),
  add column if not exists run_rejected text check (run_rejected is null or run_rejected ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  add column if not exists error_code text check (error_code is null or error_code ~ '^[A-Za-z0-9_.:-]{1,64}$');

create index if not exists capability_events_finished_time_idx
  on chumbo_telemetry.capability_events (installation_id, surface_id, occurred_at desc)
  where event_type = 'capability.finished';

create index if not exists capability_events_subject_time_idx
  on chumbo_telemetry.capability_events (installation_id, surface_id, subject, occurred_at desc)
  where event_type = 'capability.finished' and subject is not null;

create index if not exists capability_events_run_time_idx
  on chumbo_telemetry.capability_events (installation_id, surface_id, run_id, occurred_at asc)
  where event_type = 'capability.finished' and run_id is not null;

create table if not exists chumbo_telemetry.bridge_nonces (
  direction text not null,
  nonce text not null check (nonce ~ '^[A-Za-z0-9_-]{22,86}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now(),
  primary key (direction, nonce)
);

alter table chumbo_telemetry.bridge_nonces
  drop constraint if exists bridge_nonces_direction_check;
alter table chumbo_telemetry.bridge_nonces
  add constraint bridge_nonces_direction_check
  check (direction in ('event', 'aggregate', 'surface', 'surface-read'));

create table if not exists chumbo_telemetry.surface_proofs (
  installation_id text not null check (char_length(installation_id) between 1 and 128),
  surface_id text not null check (char_length(surface_id) between 1 and 128),
  proof_digest text not null check (proof_digest ~ '^sha256:[0-9a-f]{64}$'),
  proof jsonb not null check (jsonb_typeof(proof) = 'object'),
  captured_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (installation_id, surface_id),
  check (octet_length(proof::text) <= 262144)
);

create table if not exists chumbo_telemetry.installation_artifacts (
  artifact_id text primary key,
  artifact_digest text not null check (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  installed_at timestamptz not null default now()
);

alter table chumbo_telemetry.capability_events enable row level security;
alter table chumbo_telemetry.capability_events force row level security;
alter table chumbo_telemetry.bridge_nonces enable row level security;
alter table chumbo_telemetry.bridge_nonces force row level security;
alter table chumbo_telemetry.installation_artifacts enable row level security;
alter table chumbo_telemetry.installation_artifacts force row level security;
alter table chumbo_telemetry.surface_proofs enable row level security;
alter table chumbo_telemetry.surface_proofs force row level security;
revoke all on all tables in schema chumbo_telemetry from public, anon, authenticated;
grant select, insert, delete on chumbo_telemetry.capability_events to service_role;
grant select, insert, delete on chumbo_telemetry.bridge_nonces to service_role;
grant select, insert, update on chumbo_telemetry.installation_artifacts to service_role;
grant select, insert, update on chumbo_telemetry.surface_proofs to service_role;

create or replace function chumbo_telemetry.prune_capability_events(
  retention_days integer default 400
)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare deleted_rows integer;
begin
  if retention_days < 1 or retention_days > 3650 then
    raise exception 'invalid retention_days';
  end if;
  delete from chumbo_telemetry.capability_events
  where occurred_at < now() - make_interval(days => retention_days);
  get diagnostics deleted_rows = row_count;
  return deleted_rows;
end;
$$;

revoke all on function chumbo_telemetry.prune_capability_events(integer) from public, anon, authenticated;
grant execute on function chumbo_telemetry.prune_capability_events(integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$
      select cron.schedule(
        'chumbo_telemetry_prune_daily',
        '17 3 * * *',
        $$select chumbo_telemetry.prune_capability_events(400)$$
      )
    $cron$;
  end if;
exception when others then
  null;
end;
$$;

-- Fail-closed admin check for self-hosted People and cross-member Runs.
-- Builders replace this function to admit organization admins, for example:
--   select coalesce((u.raw_app_meta_data ->> 'role') = 'admin', false)
--   from auth.users u where u.id = uid
-- Never trust user-editable raw_user_meta_data for admin authorization.
create or replace function chumbo_telemetry.insights_is_admin(uid uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select false
$$;

revoke all on function chumbo_telemetry.insights_is_admin(uuid) from public, anon;
grant execute on function chumbo_telemetry.insights_is_admin(uuid) to authenticated, service_role;

create or replace function public.chumbo_telemetry_consume_nonce(
  requested_direction text,
  requested_nonce text,
  requested_expires_at timestamptz
)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $$
begin
  delete from chumbo_telemetry.bridge_nonces where expires_at <= now();
  insert into chumbo_telemetry.bridge_nonces (direction, nonce, expires_at)
  values (requested_direction, requested_nonce, requested_expires_at)
  on conflict do nothing;
  return found;
end;
$$;

create or replace function public.chumbo_telemetry_ingest(
  requested_installation_id text,
  requested_surface_id text,
  requested_event_type text,
  requested_occurred_at timestamptz,
  requested_trace_id text,
  requested_event_fingerprint text,
  requested_server_name text,
  requested_server_version text,
  requested_capability_kind text,
  requested_capability_name text,
  requested_actor_hash text,
  requested_client_hash text,
  requested_authentication_mode text,
  requested_authentication_strategy text,
  requested_run_id text,
  requested_duration_ms integer,
  requested_outcome text
)
returns boolean
language sql volatile security invoker set search_path = '' as $$
  with inserted as (
    insert into chumbo_telemetry.capability_events (
      installation_id, surface_id, event_type, occurred_at, trace_id,
      event_fingerprint,
      server_name, server_version, capability_kind, capability_name,
      actor_hash, client_hash, authentication_mode, authentication_strategy,
      run_id, duration_ms, outcome
    ) values (
      requested_installation_id, requested_surface_id, requested_event_type,
      requested_occurred_at, requested_trace_id, requested_event_fingerprint,
      requested_server_name,
      requested_server_version, requested_capability_kind,
      requested_capability_name, requested_actor_hash, requested_client_hash,
      requested_authentication_mode, requested_authentication_strategy,
      requested_run_id, requested_duration_ms, requested_outcome
    ) on conflict do nothing returning 1
  ) select exists(select 1 from inserted)
$$;

create or replace function public.chumbo_telemetry_ingest_v2(
  requested_installation_id text,
  requested_surface_id text,
  requested_event_type text,
  requested_occurred_at timestamptz,
  requested_trace_id text,
  requested_event_fingerprint text,
  requested_server_name text,
  requested_server_version text,
  requested_capability_kind text,
  requested_capability_name text,
  requested_subject text,
  requested_client_id text,
  requested_authentication_mode text,
  requested_authentication_strategy text,
  requested_run_id text,
  requested_run_started_at timestamptz,
  requested_session_id text,
  requested_run_rejected text,
  requested_error_code text,
  requested_duration_ms integer,
  requested_outcome text
)
returns boolean
language sql volatile security invoker set search_path = '' as $$
  with inserted as (
    insert into chumbo_telemetry.capability_events (
      installation_id, surface_id, event_type, occurred_at, trace_id,
      event_fingerprint,
      server_name, server_version, capability_kind, capability_name,
      subject, client_id, authentication_mode, authentication_strategy,
      run_id, run_started_at, session_id, run_rejected, error_code,
      duration_ms, outcome
    ) values (
      requested_installation_id, requested_surface_id, requested_event_type,
      requested_occurred_at, requested_trace_id, requested_event_fingerprint,
      requested_server_name,
      requested_server_version, requested_capability_kind,
      requested_capability_name, requested_subject, requested_client_id,
      requested_authentication_mode, requested_authentication_strategy,
      requested_run_id, requested_run_started_at, requested_session_id,
      requested_run_rejected, requested_error_code,
      requested_duration_ms, requested_outcome
    ) on conflict do nothing returning 1
  ) select exists(select 1 from inserted)
$$;

create or replace function public.chumbo_analytics_aggregate(
  requested_installation_id text,
  requested_surface_id text,
  requested_lookback_days integer,
  requested_top_limit integer,
  requested_as_of timestamptz
)
returns jsonb
language sql stable security invoker set search_path = '' as $$
with bounded as (
  select *, coalesce(actor_hash, subject) as principal_key
  from chumbo_telemetry.capability_events
  where installation_id = requested_installation_id
    and surface_id = requested_surface_id
    and event_type = 'capability.finished'
    and occurred_at >= requested_as_of - make_interval(days => requested_lookback_days)
    and occurred_at < requested_as_of
    and requested_lookback_days in (7, 30, 90)
    and requested_top_limit = 10
), totals as (
  select count(*)::int finished,
    count(distinct principal_key)::int active_principals,
    coalesce(avg((outcome = 'success')::int), 0)::float8 success_rate,
    percentile_cont(0.5) within group (order by duration_ms)::float8 p50,
    percentile_cont(0.95) within group (order by duration_ms)::float8 p95,
    max(occurred_at) latest
  from bounded
), outcomes as (
  select count(*) filter (where outcome='success')::int success,
    count(*) filter (where outcome='tool-error')::int tool_error,
    count(*) filter (where outcome='input-required')::int input_required,
    count(*) filter (where outcome='failure')::int failure from bounded
), top_capabilities as (
  select capability_kind kind, capability_name name, count(*)::int finished,
    count(distinct principal_key)::int active_principals,
    avg((outcome='success')::int)::float8 success_rate,
    percentile_cont(0.5) within group (order by duration_ms)::float8 p50_ms,
    percentile_cont(0.95) within group (order by duration_ms)::float8 p95_ms
  from bounded group by 1,2 order by finished desc, kind, name limit 10
), auth_partitions as (
  select authentication_mode mode, authentication_strategy strategy,
    count(*)::int finished, count(distinct principal_key)::int active_principals
  from bounded group by 1,2 order by finished desc, mode, strategy limit 10
), daily as (
  select occurred_at::date date, count(*)::int finished,
    count(distinct principal_key)::int active_principals
  from bounded group by 1 order by date
)
select jsonb_build_object(
  'period', jsonb_build_object('lookbackDays', requested_lookback_days,
    'from', to_char(requested_as_of - make_interval(days => requested_lookback_days), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'to', to_char(requested_as_of, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'totals', jsonb_build_object('finished', totals.finished,
    'activePrincipals', totals.active_principals, 'successRate', totals.success_rate),
  'outcomeMix', jsonb_build_object('success', outcomes.success,
    'toolError', outcomes.tool_error, 'inputRequired', outcomes.input_required,
    'failure', outcomes.failure),
  'latency', jsonb_build_object('p50Ms', totals.p50, 'p95Ms', totals.p95),
  'latestEventTime', case when totals.latest is null then null else to_jsonb(to_char(totals.latest, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) end,
  'topCapabilities', coalesce((select jsonb_agg(jsonb_build_object(
    'kind', kind, 'name', name, 'finished', finished,
    'activePrincipals', active_principals, 'successRate', success_rate,
    'p50Ms', p50_ms, 'p95Ms', p95_ms) order by finished desc, kind, name)
    from top_capabilities), '[]'::jsonb),
  'authPartitions', coalesce((select jsonb_agg(jsonb_build_object(
    'mode', mode, 'strategy', strategy, 'finished', finished,
    'activePrincipals', active_principals) order by finished desc, mode, strategy)
    from auth_partitions), '[]'::jsonb),
  'dailyActivity', coalesce((select jsonb_agg(jsonb_build_object(
    'date', date::text, 'finished', finished, 'activePrincipals', active_principals)
    order by date) from daily), '[]'::jsonb)
) from totals cross join outcomes
$$;

create or replace function public.chumbo_insights_aggregate(
  requested_lookback_days integer default 30,
  requested_installation_id text default 'self-hosted',
  requested_surface_id text default 'default'
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  caller_uid uuid := auth.uid();
  as_of timestamptz := now();
begin
  if requested_lookback_days not in (7, 30, 90) then
    raise exception 'unsupported lookback_days';
  end if;
  if current_user <> 'service_role' and not chumbo_telemetry.insights_is_admin(caller_uid) then
    raise exception 'insights_admin_required';
  end if;
  return public.chumbo_analytics_aggregate(
    requested_installation_id,
    requested_surface_id,
    requested_lookback_days,
    10,
    as_of
  );
end;
$$;

create or replace function public.chumbo_insights_people(
  requested_lookback_days integer default 30,
  requested_installation_id text default 'self-hosted',
  requested_surface_id text default 'default'
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  caller_uid uuid := auth.uid();
  as_of timestamptz := now();
  window_from timestamptz := as_of - make_interval(days => requested_lookback_days);
begin
  if requested_lookback_days not in (7, 30, 90) then
    raise exception 'unsupported lookback_days';
  end if;
  if current_user <> 'service_role' and not chumbo_telemetry.insights_is_admin(caller_uid) then
    raise exception 'insights_admin_required';
  end if;
  return (
    with directory as (
      select
        u.id::text as subject_id,
        coalesce(
          nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
          nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
          nullif(btrim(u.email), ''),
          'Member ' || left(u.id::text, 8)
        ) as display_name,
        nullif(btrim(u.email), '') as email
      from auth.users u
    ),
    events as (
      select *
      from chumbo_telemetry.capability_events
      where installation_id = requested_installation_id
        and surface_id = requested_surface_id
        and event_type = 'capability.finished'
        and subject is not null
        and occurred_at >= window_from
        and occurred_at < as_of
    ),
    subjects as (
      select subject_id, display_name, email, false as is_former_member from directory
      union
      select
        e.subject as subject_id,
        'Former member' as display_name,
        null::text as email,
        true as is_former_member
      from events e
      where not exists (select 1 from directory d where d.subject_id = e.subject)
      group by e.subject
    ),
    per_subject as (
      select
        s.subject_id,
        s.display_name,
        s.email,
        s.is_former_member,
        count(e.id)::int as finished_calls,
        count(distinct case when e.run_id is not null and e.run_rejected is null then e.run_id end)::int as run_count,
        count(distinct (e.occurred_at at time zone 'UTC')::date)::int as active_days,
        count(e.id) filter (where e.outcome in ('tool-error', 'failure'))::int as failures,
        max(e.occurred_at) as last_active_at
      from subjects s
      left join events e on e.subject = s.subject_id
      group by s.subject_id, s.display_name, s.email, s.is_former_member
    )
    select jsonb_build_object(
      'period', jsonb_build_object(
        'lookbackDays', requested_lookback_days,
        'from', to_char(window_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'to', to_char(as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'people', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.subject_id,
            'displayName', p.display_name,
            'email', p.email,
            'finishedCalls', p.finished_calls,
            'runCount', p.run_count,
            'activeDays', p.active_days,
            'failures', p.failures,
            'lastActiveAt', case
              when p.last_active_at is null then null
              else to_jsonb(to_char(p.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            end,
            'isFormerMember', p.is_former_member,
            'topCapabilities', coalesce((
              select jsonb_agg(
                jsonb_build_object('kind', c.capability_kind, 'name', c.capability_name, 'finished', c.cnt)
                order by c.cnt desc, c.capability_kind, c.capability_name
              )
              from (
                select capability_kind, capability_name, count(*)::int as cnt
                from events ev
                where ev.subject = p.subject_id
                group by 1, 2
                order by cnt desc, capability_kind, capability_name
                limit 5
              ) c
            ), '[]'::jsonb)
          )
          order by lower(p.display_name), coalesce(lower(p.email), ''), p.subject_id
        )
        from per_subject p
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.chumbo_insights_runs(
  p_member text,
  p_from timestamptz,
  p_to timestamptz,
  requested_installation_id text default 'self-hosted',
  requested_surface_id text default 'default',
  requested_limit integer default 500
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  caller_uid uuid := auth.uid();
  bounded_limit integer := greatest(1, least(coalesce(requested_limit, 500), 1000));
begin
  if p_member is null or char_length(btrim(p_member)) = 0 then
    raise exception 'member_required';
  end if;
  if p_to <= p_from then
    raise exception 'invalid_period';
  end if;
  if current_user <> 'service_role'
     and not chumbo_telemetry.insights_is_admin(caller_uid)
     and (caller_uid is null or caller_uid::text <> p_member)
  then
    raise exception 'insights_admin_required';
  end if;
  return (
    with member_row as (
      select
        u.id::text as id,
        coalesce(
          nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
          nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
          nullif(btrim(u.email), ''),
          'Member ' || left(u.id::text, 8)
        ) as display_name,
        nullif(btrim(u.email), '') as email,
        false as is_former_member
      from auth.users u
      where u.id::text = p_member
    ),
    fetched as (
      select *
      from chumbo_telemetry.capability_events
      where installation_id = requested_installation_id
        and surface_id = requested_surface_id
        and event_type = 'capability.finished'
        and subject = p_member
        and occurred_at >= p_from
        and occurred_at < p_to
      order by occurred_at desc, id desc
      limit bounded_limit + 1
    ),
    page as (
      select * from fetched limit bounded_limit
    )
    select jsonb_build_object(
      'member', coalesce(
        (select jsonb_build_object(
          'id', m.id,
          'displayName', m.display_name,
          'email', m.email,
          'isFormerMember', m.is_former_member
        ) from member_row m),
        jsonb_build_object(
          'id', p_member,
          'displayName', 'Former member',
          'email', null,
          'isFormerMember', true
        )
      ),
      'events', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'occurredAt', to_char(p.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'capabilityKind', p.capability_kind,
            'capabilityName', p.capability_name,
            'durationMs', p.duration_ms,
            'outcome', p.outcome,
            'runId', p.run_id,
            'runStartedAt', case
              when p.run_started_at is null then null
              else to_jsonb(to_char(p.run_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            end,
            'runRejected', p.run_rejected,
            'errorCode', p.error_code,
            'clientLabel', p.client_id
          )
          order by p.occurred_at asc, p.id asc
        )
        from page p
      ), '[]'::jsonb),
      'hasMore', (select count(*) > bounded_limit from fetched),
      'nextBefore', (
        select to_char(min(p.occurred_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        from page p
      )
    )
  );
end;
$$;

create or replace function public.chumbo_surface_proof_upsert(
  requested_installation_id text,
  requested_surface_id text,
  requested_proof_digest text,
  requested_proof jsonb,
  requested_captured_at timestamptz
)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $$
begin
  insert into chumbo_telemetry.surface_proofs (
    installation_id, surface_id, proof_digest, proof, captured_at, updated_at
  ) values (
    requested_installation_id, requested_surface_id, requested_proof_digest,
    requested_proof, requested_captured_at, now()
  ) on conflict (installation_id, surface_id) do update
    set proof_digest = excluded.proof_digest,
        proof = excluded.proof,
        captured_at = excluded.captured_at,
        updated_at = now()
    where chumbo_telemetry.surface_proofs.proof_digest is distinct from excluded.proof_digest;
  return true;
end;
$$;

create or replace function public.chumbo_surface_proof_latest(
  requested_installation_id text,
  requested_surface_id text
)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('capturedAt', captured_at, 'proof', proof)
  from chumbo_telemetry.surface_proofs
  where installation_id = requested_installation_id
    and surface_id = requested_surface_id
$$;

revoke all on function public.chumbo_telemetry_consume_nonce(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.chumbo_telemetry_ingest(text, text, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.chumbo_telemetry_ingest_v2(text, text, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, timestamptz, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.chumbo_analytics_aggregate(text, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.chumbo_telemetry_consume_nonce(text, text, timestamptz) to service_role;
grant execute on function public.chumbo_telemetry_ingest(text, text, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, text) to service_role;
grant execute on function public.chumbo_telemetry_ingest_v2(text, text, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, timestamptz, text, text, text, integer, text) to service_role;
grant execute on function public.chumbo_analytics_aggregate(text, text, integer, integer, timestamptz) to service_role;
revoke all on function public.chumbo_insights_aggregate(integer, text, text) from public, anon;
revoke all on function public.chumbo_insights_people(integer, text, text) from public, anon;
revoke all on function public.chumbo_insights_runs(text, timestamptz, timestamptz, text, text, integer) from public, anon;
grant execute on function public.chumbo_insights_aggregate(integer, text, text) to authenticated, service_role;
grant execute on function public.chumbo_insights_people(integer, text, text) to authenticated, service_role;
grant execute on function public.chumbo_insights_runs(text, timestamptz, timestamptz, text, text, integer) to authenticated, service_role;
revoke all on function public.chumbo_surface_proof_upsert(text,text,text,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.chumbo_surface_proof_latest(text,text) from public, anon, authenticated;
grant execute on function public.chumbo_surface_proof_upsert(text,text,text,jsonb,timestamptz) to service_role;
grant execute on function public.chumbo_surface_proof_latest(text,text) to service_role;

insert into chumbo_telemetry.installation_artifacts (artifact_id, artifact_digest)
values ('chumbo-telemetry@2', 'sha256:bc2a1697324b0b7f45ccfd9b1e3bb8fb09ab7e4c7632aa3de6aeca320661ed49')
on conflict (artifact_id) do update set artifact_digest=excluded.artifact_digest, installed_at=now();
