-- Appointment notifications are outreach, not operator replies. Keep their
-- messages visible in conversations while excluding them from attendance KPIs.
update messages m set attendance_relevant=false
where m.direction='out' and m.attendance_relevant
and exists(select 1 from appointment_notifications n where n.message=m.id);
