-- Null preserves the unknown scheduling outcome of historical attendances.
alter table attendance_history add column scheduling jsonb;
