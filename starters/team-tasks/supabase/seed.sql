-- Local demo data. Two users whose data overlaps partially:
--   alice@example.com / password123  -> Alice's Studio + Launch Crew
--   bob@example.com   / password123  -> Bob's Garage   + Launch Crew
-- Never run this seed against a production project.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    'a11ce000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'alice@example.com',
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"name":"Alice"}',
    now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b0b00000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'bob@example.com',
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"name":"Bob"}',
    now(), now(), '', '', '', ''
  );

insert into auth.identities (
  id, user_id, provider_id, provider, identity_data,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(), id, id::text, 'email',
  jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
  now(), now(), now()
from auth.users
where id in (
  'a11ce000-0000-4000-8000-000000000001',
  'b0b00000-0000-4000-8000-000000000002'
);

insert into public.teams (id, name) values
  ('7ea30000-0000-4000-8000-00000000000a', 'Alice''s Studio'),
  ('7ea30000-0000-4000-8000-00000000000b', 'Bob''s Garage'),
  ('7ea30000-0000-4000-8000-00000000000c', 'Launch Crew');

insert into public.team_members (team_id, user_id, role) values
  ('7ea30000-0000-4000-8000-00000000000a', 'a11ce000-0000-4000-8000-000000000001', 'owner'),
  ('7ea30000-0000-4000-8000-00000000000b', 'b0b00000-0000-4000-8000-000000000002', 'owner'),
  ('7ea30000-0000-4000-8000-00000000000c', 'a11ce000-0000-4000-8000-000000000001', 'owner'),
  ('7ea30000-0000-4000-8000-00000000000c', 'b0b00000-0000-4000-8000-000000000002', 'member');

insert into public.tasks (team_id, title, status, created_by) values
  ('7ea30000-0000-4000-8000-00000000000a', 'Sketch the new logo', 'doing', 'a11ce000-0000-4000-8000-000000000001'),
  ('7ea30000-0000-4000-8000-00000000000a', 'Send invoice to Acme', 'todo', 'a11ce000-0000-4000-8000-000000000001'),
  ('7ea30000-0000-4000-8000-00000000000b', 'Replace the brake pads', 'todo', 'b0b00000-0000-4000-8000-000000000002'),
  ('7ea30000-0000-4000-8000-00000000000b', 'Order winter tyres', 'done', 'b0b00000-0000-4000-8000-000000000002'),
  ('7ea30000-0000-4000-8000-00000000000c', 'Write the launch post', 'doing', 'a11ce000-0000-4000-8000-000000000001'),
  ('7ea30000-0000-4000-8000-00000000000c', 'Record the demo video', 'todo', 'b0b00000-0000-4000-8000-000000000002');
