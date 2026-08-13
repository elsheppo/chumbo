create table public.csm_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table public.csm_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.csm_organizations(id) on delete cascade,
  primary key (user_id, organization_id)
);

create table public.csm_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.csm_organizations(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.csm_organizations enable row level security;
alter table public.csm_memberships enable row level security;
alter table public.csm_documents enable row level security;

revoke all on table public.csm_organizations from anon, authenticated;
revoke all on table public.csm_memberships from anon, authenticated;
revoke all on table public.csm_documents from anon, authenticated;

grant select on table public.csm_organizations to authenticated;
grant select on table public.csm_memberships to authenticated;
grant select on table public.csm_documents to authenticated;
grant all on table public.csm_organizations, public.csm_memberships, public.csm_documents to service_role;

create policy "Users see their own example memberships"
on public.csm_memberships
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Members see their example organizations"
on public.csm_organizations
for select
to authenticated
using (
  exists (
    select 1
    from public.csm_memberships
    where csm_memberships.organization_id = csm_organizations.id
      and csm_memberships.user_id = (select auth.uid())
  )
);

create policy "Members see their example documents"
on public.csm_documents
for select
to authenticated
using (
  exists (
    select 1
    from public.csm_memberships
    where csm_memberships.organization_id = csm_documents.organization_id
      and csm_memberships.user_id = (select auth.uid())
  )
);
