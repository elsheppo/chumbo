create table public.demo_guarded_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  content text not null check (octet_length(content) <= 65536),
  version bigint not null default 1 check (
    version between 1 and 9007199254740991
  ),
  updated_at timestamptz not null default clock_timestamp()
);

create index demo_guarded_documents_owner_updated_idx
  on public.demo_guarded_documents (owner_id, updated_at desc);

alter table public.demo_guarded_documents enable row level security;
create policy "Users read their own guarded documents"
  on public.demo_guarded_documents
  for select
  to authenticated
  using ((select auth.uid()) = owner_id);

grant select on public.demo_guarded_documents to authenticated;
grant all on public.demo_guarded_documents to service_role;

create or replace function public.edit_demo_guarded_document(
  p_document_id uuid,
  p_expected_version bigint,
  p_old_text text,
  p_new_text text
)
returns table (
  status text,
  id uuid,
  title text,
  content text,
  version bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.demo_guarded_documents%rowtype;
  v_match_count integer;
begin
  if p_document_id is null
    or p_expected_version is null
    or p_expected_version not between 1 and 9007199254740991
    or p_old_text is null
    or p_old_text = ''
    or octet_length(p_old_text) > 8000
    or p_new_text is null
    or octet_length(p_new_text) > 8000
  then
    raise exception 'invalid guarded edit input';
  end if;

  select document.*
    into v_document
  from public.demo_guarded_documents as document
  where document.id = p_document_id
    and document.owner_id = (select auth.uid())
  for update;

  if not found then
    status := 'missing';
    return next;
    return;
  end if;

  id := v_document.id;
  title := v_document.title;
  content := v_document.content;
  version := v_document.version;

  if v_document.version <> p_expected_version then
    status := 'stale';
    return next;
    return;
  end if;

  v_match_count := (
    char_length(v_document.content) -
    char_length(replace(v_document.content, p_old_text, ''))
  ) / char_length(p_old_text);

  if v_match_count = 0 then
    status := 'text_missing';
    return next;
    return;
  end if;
  if v_match_count > 1 then
    status := 'text_not_unique';
    return next;
    return;
  end if;

  update public.demo_guarded_documents as document
  set
    content = replace(document.content, p_old_text, p_new_text),
    version = document.version + 1,
    updated_at = clock_timestamp()
  where document.id = v_document.id
  returning document.content, document.version
    into content, version;

  status := 'written';
  return next;
end;
$$;

revoke all on function public.edit_demo_guarded_document(
  uuid, bigint, text, text
) from public, anon;
grant execute on function public.edit_demo_guarded_document(
  uuid, bigint, text, text
) to authenticated, service_role;

comment on table public.demo_guarded_documents is
  'Living-reference data for the optional observation-before-action pattern; not an application schema prescription.';
