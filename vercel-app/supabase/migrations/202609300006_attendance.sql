alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check(role in ('admin','receptionist','agent','viewer'));
alter table conversations add column assigned_to uuid references users(id) on delete set null;
alter table conversations add column assigned_at bigint;
create index conversations_assignment_idx on conversations(tenant,assigned_to,status);
create table attendance_history(
 id uuid primary key default gen_random_uuid(),tenant uuid not null references tenants(id),
 conversation uuid not null references conversations(id),actor uuid references users(id) on delete set null,
 actor_name text not null,action text not null,previous_owner uuid,next_owner uuid,
 created bigint not null
);
alter table attendance_history enable row level security;
update conversations c set assigned_to=m.operator_id,assigned_at=m.created
from (select distinct on(conversation) conversation,operator_id,created from messages
where direction='out' and operator_id is not null order by conversation,created desc) m
where c.id=m.conversation;
update crm_opportunities o set owner=c.assigned_to from conversations c where c.id=o.conversation;
create table crm_pending_referrals(
 tenant uuid not null references tenants(id),account uuid not null references accounts(id),
 customer text not null,event_key text not null,referral jsonb not null,created bigint not null,
 primary key(account,customer,event_key)
);
alter table crm_pending_referrals enable row level security;
