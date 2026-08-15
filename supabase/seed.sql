insert into public.reference_servers (slug, name, instructions, enabled)
values
  (
    'directory',
    'Local Business Directory',
    'Find businesses in a small local directory.',
    true
  ),
  (
    'invoices',
    'Invoice Desk',
    'Inspect a small demonstration invoice ledger.',
    true
  )
on conflict (slug) do update set
  name = excluded.name,
  instructions = excluded.instructions,
  enabled = excluded.enabled;

insert into public.reference_tools (
  server_slug,
  name,
  title,
  description,
  response,
  position
)
values
  (
    'directory',
    'list_businesses',
    'List local businesses',
    'List the businesses available in this demonstration directory.',
    '{"businesses":[{"name":"North Star Books","category":"bookstore"},{"name":"Juniper Coffee","category":"cafe"}]}'::jsonb,
    1
  ),
  (
    'invoices',
    'list_invoices',
    'List invoices',
    'List the invoices available in this demonstration ledger.',
    '{"invoices":[{"customer":"Wayfarer Labs","amount_usd":1200,"status":"unpaid"},{"customer":"Nimbus Post","amount_usd":450,"status":"paid"}]}'::jsonb,
    1
  )
on conflict (server_slug, name) do update set
  title = excluded.title,
  description = excluded.description,
  response = excluded.response,
  position = excluded.position;
