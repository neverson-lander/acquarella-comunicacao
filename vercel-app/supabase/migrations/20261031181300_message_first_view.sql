-- Historical views were session-local and cannot be reconstructed.
alter table messages add column if not exists first_viewed_at bigint;
alter table messages add column if not exists first_viewed_by uuid references users(id) on delete set null;
create index if not exists messages_first_viewed_idx on messages(conversation,first_viewed_at) where first_viewed_at is not null;
