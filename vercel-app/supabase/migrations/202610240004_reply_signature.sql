alter table messages add column signature_user uuid references users(id) on delete set null;
alter table messages add column signature_name text not null default '';
