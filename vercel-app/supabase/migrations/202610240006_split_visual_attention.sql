alter table accounts add column visual_queue_minutes integer check(visual_queue_minutes between 1 and 1440);
alter table accounts add column visual_assigned_minutes integer check(visual_assigned_minutes between 1 and 1440);
update accounts set visual_queue_minutes=visual_alert_minutes,visual_assigned_minutes=visual_alert_minutes;
alter table accounts alter column visual_queue_minutes set not null;
alter table accounts alter column visual_assigned_minutes set not null;
alter table accounts alter column visual_queue_minutes set default 30;
alter table accounts alter column visual_assigned_minutes set default 30;
