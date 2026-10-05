alter table accounts add column alerts_enabled boolean not null default false;
alter table accounts add column queue_alert_minutes integer not null default 15 check(queue_alert_minutes between 1 and 1440);
alter table accounts add column assigned_alert_minutes integer not null default 15 check(assigned_alert_minutes between 1 and 1440);
alter table accounts add column queue_alert_at bigint;
alter table accounts add column assigned_alert_at bigint;
create index messages_waiting_alert_idx on messages(conversation,direction,state,created);
create table alert_scheduler_requests(id bigint primary key,created timestamptz not null default now());
alter table alert_scheduler_requests enable row level security;
