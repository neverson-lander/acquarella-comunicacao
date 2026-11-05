-- A deletion is an audit record, never a removal of the original message.
create table whatsapp_deletions (
 tenant uuid not null references tenants(id) on delete cascade,
 account uuid not null references accounts(id) on delete cascade,
 customer text not null,
 target_external text not null,
 event_external text not null,
 deleted_at bigint not null,
 actor uuid references users(id) on delete set null,
 source text not null check(source in ('whatsapp','central')),
 primary key(account,customer,target_external)
);
alter table whatsapp_deletions enable row level security;
create index whatsapp_deletions_conversation_idx on whatsapp_deletions(tenant,account,customer);
