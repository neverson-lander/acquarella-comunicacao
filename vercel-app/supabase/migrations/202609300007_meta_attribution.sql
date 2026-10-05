alter table crm_ads add column creative jsonb not null default '{}'::jsonb;
alter table crm_ads add column sync_checked bigint not null default 0;
alter table crm_ads add column sync_error text not null default '';
alter table crm_touches add column meta_snapshot jsonb not null default '{}'::jsonb;
