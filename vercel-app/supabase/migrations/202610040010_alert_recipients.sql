alter table accounts add column alerts_phones jsonb not null default '[]'::jsonb
  check(jsonb_typeof(alerts_phones)='array' and jsonb_array_length(alerts_phones)<=20);
-- Preserve the destination used by the previously published alert feature.
update accounts a set alerts_phones=jsonb_build_array(t.phone) from tenants t where t.id=a.tenant;
alter table jobs add column alert_source uuid references accounts(id) on delete cascade;
alter table jobs add column alert_queue boolean not null default false;
alter table jobs add column alert_assigned boolean not null default false;
alter table jobs add column alert_started_at bigint;
update jobs j set alert_source=c.account from conversations c where j.kind='waiting_alert' and j.conversation=c.id;
create index jobs_pending_waiting_alert_idx on jobs(created) where kind='waiting_alert' and state='pending';
create index jobs_alert_source_idx on jobs(alert_source,state) where kind='waiting_alert';
