alter table cashbarber_bookings drop constraint cashbarber_bookings_state_check;
alter table cashbarber_bookings add constraint cashbarber_bookings_state_check check(state in ('preview','pending','confirmed','rejected','uncertain','cancelled','rescheduled'));
create table cashbarber_changes (
 id uuid primary key default gen_random_uuid(),
 tenant uuid not null references tenants(id) on delete cascade,
 conversation uuid not null references conversations(id) on delete cascade,
 actor uuid not null references users(id),
 external_id text not null,
 client_id text not null,
 kind text not null check(kind in ('update','cancel')),
 state text not null check(state in ('preview','pending','confirmed','rejected','uncertain')),
 preview jsonb not null,
 result jsonb,
 created bigint not null,
 updated bigint not null,
 expires bigint not null
);
create unique index cashbarber_changes_pending on cashbarber_changes(tenant,external_id) where state in ('pending','uncertain');
create index cashbarber_changes_conversation on cashbarber_changes(tenant,conversation,created);
alter table cashbarber_changes enable row level security;
