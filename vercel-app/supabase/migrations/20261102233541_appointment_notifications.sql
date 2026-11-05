create table appointment_notification_settings (
  tenant uuid primary key references tenants(id) on delete cascade,
  enabled boolean not null default false,
  account uuid references accounts(id) on delete set null,
  updated bigint not null,
  last_run bigint,
  error text not null default '',
  cursor text not null default '',
  lease uuid,
  lease_until bigint not null default 0
);
create table appointment_notification_observations (
  tenant uuid not null references tenants(id) on delete cascade,
  external_id text not null,
  starts_at bigint,
  booked_at bigint,
  primary key(tenant,external_id)
);
create table appointment_notifications (
  id uuid primary key,
  tenant uuid not null references tenants(id) on delete cascade,
  account uuid not null references accounts(id) on delete cascade,
  external_id text not null,
  revision text not null,
  kind text not null check(kind in ('confirmation','reminder')),
  due bigint not null,
  state text not null check(state in ('pending','sending','sent','failed','uncertain','cancelled','expired')),
  body text not null,
  message uuid references messages(id) on delete set null,
  external text,
  error text not null default '',
  updated bigint not null,
  unique(tenant,external_id,revision,kind)
);
create index appointment_notifications_due on appointment_notifications(tenant,due) where state='pending';
create index appointment_notifications_history on appointment_notifications(tenant,updated desc);
alter table appointment_notification_settings enable row level security;
alter table appointment_notification_observations enable row level security;
alter table appointment_notifications enable row level security;
revoke all on appointment_notification_settings,appointment_notification_observations,appointment_notifications from public;
-- Application sessions use the server database connection; there is no Data API access.
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on appointment_notification_settings,appointment_notification_observations,appointment_notifications from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on appointment_notification_settings,appointment_notification_observations,appointment_notifications from authenticated;
  end if;
end $$;
