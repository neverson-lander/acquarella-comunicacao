alter table accounts add column evaluation_enabled boolean not null default false;
create table ai_connections(
 tenant uuid primary key references tenants(id),host_id text not null,
 client_id text,subject text,email text,credentials text,
 model text not null default '',guidance text not null default '',
 state text not null default 'disconnected',updated bigint not null
);
create table ai_pairings(
 tenant uuid primary key references tenants(id),token_hash text not null unique,
 expires bigint not null,nonce text,client_id text,started boolean not null default false
);
create table attendance_evaluations(
 id uuid primary key default gen_random_uuid(),tenant uuid not null references tenants(id),
 account uuid not null references accounts(id),conversation uuid not null references conversations(id),
 closure uuid not null unique references attendance_history(id),
 owner uuid references users(id) on delete set null,owner_name text not null,
 state text not null default 'pending' check(state in ('pending','processing','waiting','completed','failed','skipped','cancelled')),
 snapshot jsonb not null,result jsonb,score numeric(3,1) check(score between 0 and 10),
 rubric text not null default 'sales-v1',model text not null default '',
 attempts integer not null default 0,next_attempt bigint not null,lease uuid,
 error text not null default '',created bigint not null,updated bigint not null
);
create index attendance_evaluations_queue on attendance_evaluations(state,next_attempt);
create index attendance_evaluations_tenant on attendance_evaluations(tenant,conversation,created);
alter table ai_connections enable row level security;
alter table ai_pairings enable row level security;
alter table attendance_evaluations enable row level security;
