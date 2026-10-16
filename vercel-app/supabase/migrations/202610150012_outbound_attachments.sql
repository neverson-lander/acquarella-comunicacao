create table reply_attachments (
 id uuid primary key,
 tenant uuid not null references tenants(id) on delete cascade,
 conversation uuid not null references conversations(id) on delete cascade,
 uploader uuid not null references users(id),
 name text not null, mime text not null, kind text not null check(kind in ('image','audio','video','file')),
 size integer not null check(size between 1 and 26214400),
 ready boolean not null default false,
 message uuid unique references messages(id) on delete cascade,
 created bigint not null
);
create index reply_attachments_conversation_idx on reply_attachments(conversation);
create index reply_attachments_pending_idx on reply_attachments(tenant,uploader,created) where message is null;
create table reply_attachment_parts (
 attachment uuid not null references reply_attachments(id) on delete cascade,
 part integer not null check(part between 0 and 24),
 secret text not null,
 primary key(attachment,part)
);
alter table reply_attachments enable row level security;
alter table reply_attachment_parts enable row level security;
revoke all on reply_attachments,reply_attachment_parts from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  revoke all on reply_attachments,reply_attachment_parts from anon;
 end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then
  revoke all on reply_attachments,reply_attachment_parts from authenticated;
 end if;
end $$;
