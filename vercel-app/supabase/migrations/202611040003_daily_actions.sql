alter table appointment_notifications drop constraint appointment_notifications_kind_check;
alter table appointment_notifications add constraint appointment_notifications_kind_check check(kind in ('confirmation','reminder','subscription'));
alter table appointment_notifications add column notice text not null default '';
alter table appointment_notifications add column source jsonb not null default '{}'::jsonb;
create table daily_action_settings (
 tenant uuid not null references tenants(id) on delete cascade,
 feature text not null check(feature in ('subscriptions','comandas')),
 enabled boolean not null default false,
 account uuid references accounts(id) on delete set null,
 cashbox text not null default '',
 payment_method text not null default '',
 updated bigint not null,
 enabled_at bigint,
 last_run bigint,
 error text not null default '',
 lease uuid,
 lease_until bigint not null default 0,
 primary key(tenant,feature)
);
create table daily_action_runs (
 id uuid primary key,
 tenant uuid not null references tenants(id) on delete cascade,
 feature text not null,
 day text not null,
 state text not null default 'discovering' check(state in ('discovering','executing','complete','cancelled')),
 cursor integer not null default 0,
 payload jsonb not null default '{}'::jsonb,
 updated bigint not null,
 unique(tenant,feature,day)
);
create table daily_action_items (
 id uuid primary key,
 tenant uuid not null references tenants(id) on delete cascade,
 run uuid not null references daily_action_runs(id) on delete cascade,
 external_id text not null,
 state text not null default 'pending' check(state in ('pending','sending','closed','skipped','failed','uncertain','cancelled')),
 error text not null default '',
 updated bigint not null,
 unique(tenant,external_id)
);
create index daily_action_items_pending on daily_action_items(run,updated) where state='pending';
insert into daily_action_settings(tenant,feature,updated) select id,f,0 from tenants cross join unnest(array['subscriptions','comandas']) f;
alter table daily_action_settings enable row level security;
alter table daily_action_runs enable row level security;
alter table daily_action_items enable row level security;
revoke all on daily_action_settings,daily_action_runs,daily_action_items from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on daily_action_settings,daily_action_runs,daily_action_items from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on daily_action_settings,daily_action_runs,daily_action_items from authenticated; end if;
end $$;
