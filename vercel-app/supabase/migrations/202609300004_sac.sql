alter table accounts add column forwarding_enabled boolean not null default true;
alter table conversations add column username text not null default '';
alter table conversations add column name_manual boolean not null default false;
alter table conversations add column profile_checked bigint not null default 0;
alter table messages add column operator_id uuid references users(id) on delete set null;
alter table messages add column operator_name text;
