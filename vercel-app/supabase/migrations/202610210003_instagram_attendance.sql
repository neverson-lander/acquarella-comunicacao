alter table conversations add column if not exists attendance_eligible boolean not null default true;
alter table messages add column if not exists attendance_relevant boolean not null default true;
