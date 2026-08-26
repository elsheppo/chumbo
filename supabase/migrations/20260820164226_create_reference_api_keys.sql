create table public.reference_api_keys (
  token_hash text primary key,
  subject text not null check (length(btrim(subject)) > 0),
  scopes text[] not null default '{}',
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.reference_api_keys enable row level security;

revoke all on table public.reference_api_keys from anon, authenticated;
grant select, insert, delete on table public.reference_api_keys to service_role;

comment on table public.reference_api_keys is
  'Living-reference credentials used only to prove composed Chumbo authentication.';
