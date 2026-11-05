alter table accounts add column visual_alert_minutes integer not null default 30 check(visual_alert_minutes between 1 and 1440);
