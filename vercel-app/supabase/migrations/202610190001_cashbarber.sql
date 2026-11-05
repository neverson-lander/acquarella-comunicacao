create table cashbarber_links (
  tenant uuid not null references tenants(id) on delete cascade,
  conversation uuid not null references conversations(id) on delete cascade,
  client_id text not null,
  client_name text not null,
  actor uuid not null references users(id),
  updated bigint not null,
  primary key(tenant,conversation)
);
create table cashbarber_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant uuid not null references tenants(id) on delete cascade,
  conversation uuid not null references conversations(id) on delete cascade,
  actor uuid not null references users(id),
  state text not null check(state in ('preview','pending','confirmed','rejected','uncertain')),
  quote jsonb not null,
  receipt jsonb,
  created bigint not null,
  updated bigint not null,
  expires bigint not null
);
create index cashbarber_bookings_conversation on cashbarber_bookings(tenant,conversation,created desc);
alter table cashbarber_links enable row level security;
alter table cashbarber_bookings enable row level security;
