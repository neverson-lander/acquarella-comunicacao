create table message_operations(
 id uuid primary key,tenant uuid not null references tenants(id),kind text not null check(kind in ('edit','forward')),
 source_message uuid not null references messages(id),actor uuid not null references users(id),actor_name text not null,
 input jsonb not null,snapshot jsonb not null,target_conversation uuid references conversations(id),target_message uuid references messages(id),
 state text not null check(state in ('sending','sent','failed','uncertain')),external text,error text not null default '',
 created bigint not null,updated bigint not null
);
create index message_operations_source_idx on message_operations(tenant,source_message,created desc);
create unique index message_operations_edit_in_progress_idx on message_operations(source_message) where kind='edit' and state='sending';
alter table message_operations enable row level security;
