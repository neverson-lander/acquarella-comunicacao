alter table crm_touches add column if not exists ignored_for_attribution boolean not null default false;
update crm_touches t set ignored_for_attribution=true
from crm_opportunities o join conversations c on c.id=o.conversation join accounts a on a.id=c.account
where t.opportunity=o.id and a.channel='instagram' and t.source='unknown' and t.evidence='webhook' and t.ad_id=''
and exists(select 1 from messages m where m.conversation=c.id and not m.attendance_relevant
 and (m.external=t.event_key or m.external=a.id::text||':'||t.event_key));
