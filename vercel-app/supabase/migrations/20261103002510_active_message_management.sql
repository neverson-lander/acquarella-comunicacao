alter table appointment_notifications
  add column client_name text not null default '',
  add column professional_name text not null default '',
  add column recipient text not null default '',
  add column starts_at bigint,
  add column cancelled_by uuid references users(id) on delete set null;
alter table appointment_notification_settings add column delivery_mode text not null default 'manual' check(delivery_mode in ('manual','automatic'));
update appointment_notifications set
  starts_at=due+case when kind='confirmation' then 86400000 else 7200000 end,
  client_name=coalesce(substring(split_part(body,E'\n',1) from '^Olá, (.*)!$'),''),
  professional_name=split_part(split_part(body,E'\n',3),' · ',2);
-- Refresh only unsent drafts; keep the original text of sent/uncertain deliveries.
update appointment_notifications set body=concat(
  'Olá, ',coalesce(nullif(split_part(btrim(client_name),' ',1),''),'tudo bem'),'!',E'\n',
  split_part(body,E'\n',2),E'\n',split_part(split_part(body,E'\n',3),' · ',1),E'\n',
  array_to_string((string_to_array(body,E'\n'))[4:],E'\n'))
where state in ('pending','expired');
-- Existing pending messages also obey the 08:00 opening time in São Paulo.
update appointment_notifications set due=greatest(due,
  (extract(epoch from (((to_timestamp(due/1000.0) at time zone 'America/Sao_Paulo')::date+time '08:00') at time zone 'America/Sao_Paulo'))*1000)::bigint)
where state='pending';
create index appointment_notifications_management on appointment_notifications(tenant,due desc,id);
