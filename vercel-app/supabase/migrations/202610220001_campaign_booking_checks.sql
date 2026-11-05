create table cashbarber_campaign_checks (
 tenant uuid not null references tenants(id),
 conversation uuid not null references conversations(id) on delete cascade,
 ad_id text not null,
 report jsonb not null,
 actor uuid references users(id) on delete set null,
 checked_at bigint not null,
 primary key(tenant,conversation,ad_id)
);
alter table cashbarber_campaign_checks enable row level security;
