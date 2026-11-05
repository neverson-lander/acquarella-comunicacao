-- Restore attribution boundaries for existing returns without changing any
-- original touch, closure, conversion or message.
with closures as (
 select h.*,lead(h.created) over(partition by h.conversation order by h.created,h.id) as next_closure
 from attendance_history h
 where h.action='Atendimento finalizado' or h.action like 'Atendimento encerrado em massa%'
), entries as (
 select h.id as closure,h.created as closure_created,h.tenant,o.id as opportunity,m.created,m.external,c.account
 from closures h
 join conversations c on c.id=h.conversation and c.tenant=h.tenant
 join crm_opportunities o on o.conversation=c.id and o.tenant=h.tenant
 join lateral (
  select m.created,m.external from messages m where m.conversation=h.conversation
   and m.direction='in' and m.attendance_relevant and m.created>h.created
   and (h.next_closure is null or m.created<h.next_closure)
  order by m.created,m.received_at,m.id limit 1
 ) m on true
)
insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,referral,created,meta_snapshot)
select e.tenant,e.opportunity,'attendance:'||e.closure::text,
 case when t.source='paid' then 'paid' else 'organic' end,'webhook',coalesce(t.ad_id,''),
 coalesce(t.referral,'{}'::jsonb)||jsonb_build_object('attendance_start',e.closure::text),e.created,coalesce(t.meta_snapshot,'{}'::jsonb)
from entries e
left join lateral (
 select t.* from crm_touches t where t.opportunity=e.opportunity and not t.ignored_for_attribution
  and (e.external=t.event_key or e.external=e.account::text||':'||t.event_key
    or (t.event_key like 'referral:%' and t.source='paid' and t.created>e.closure_created and t.created<=e.created))
 order by case when t.source='paid' then 0 else 1 end,t.created,t.id limit 1
) t on true
on conflict(opportunity,event_key) do nothing;
