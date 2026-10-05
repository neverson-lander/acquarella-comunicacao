alter table messages add column kind text not null default 'text';
alter table messages add column media jsonb not null default '{}'::jsonb;
create table whatsapp_reactions(
 tenant uuid not null references tenants(id) on delete cascade,
 account uuid not null references accounts(id) on delete cascade,
 customer text not null,event_external text not null,target_external text not null,
 emoji text not null,created bigint not null,received_order bigserial,
 primary key(account,event_external)
);
alter table whatsapp_reactions enable row level security;
create index whatsapp_reactions_target_idx on whatsapp_reactions(account,customer,target_external,created desc,received_order desc);
-- Recover metadata from retained webhooks; never invent a media URL or credential.
with contents as (
 select a.id as account,a.tenant,m.value as content
 from events e cross join lateral jsonb_array_elements(case when jsonb_typeof(e.payload->'entry')='array' then e.payload->'entry' else '[]'::jsonb end) en
 cross join lateral jsonb_array_elements(case when jsonb_typeof(en->'changes')='array' then en->'changes' else '[]'::jsonb end) ch
 cross join lateral jsonb_array_elements(case when jsonb_typeof(ch->'value'->'messages')='array' then ch->'value'->'messages' else '[]'::jsonb end) m
 join accounts a on a.tenant::text=e.tenant and a.channel='whatsapp'
   and a.external=ch->'value'->'metadata'->>'phone_number_id'
 where e.payload->>'object'='whatsapp_business_account'
)
update messages msg set kind=c.content->>'type',media=jsonb_build_object(
 'id',c.content->(c.content->>'type')->>'id','mime_type',c.content->(c.content->>'type')->>'mime_type',
 'caption',coalesce(c.content->(c.content->>'type')->>'caption',''),'voice',coalesce(c.content->'audio'->'voice','false'::jsonb))
from contents c where msg.external=c.account::text||':'||(c.content->>'id')
 and c.content->>'type' in ('image','audio','sticker') and c.content->(c.content->>'type')->>'id' ~ '^\d+$';
with contents as (
 select a.id as account,a.tenant,m.value as content
 from events e cross join lateral jsonb_array_elements(case when jsonb_typeof(e.payload->'entry')='array' then e.payload->'entry' else '[]'::jsonb end) en
 cross join lateral jsonb_array_elements(case when jsonb_typeof(en->'changes')='array' then en->'changes' else '[]'::jsonb end) ch
 cross join lateral jsonb_array_elements(case when jsonb_typeof(ch->'value'->'messages')='array' then ch->'value'->'messages' else '[]'::jsonb end) m
 join accounts a on a.tenant::text=e.tenant and a.channel='whatsapp'
   and a.external=ch->'value'->'metadata'->>'phone_number_id'
 where e.payload->>'object'='whatsapp_business_account' and m.value->>'type'='reaction'
)
insert into whatsapp_reactions(tenant,account,customer,event_external,target_external,emoji,created)
select tenant,account,content->>'from',content->>'id',content->'reaction'->>'message_id',
 coalesce(content->'reaction'->>'emoji',''),(content->>'timestamp')::bigint*1000
from contents where content->'reaction'->>'message_id' is not null and content->>'timestamp' ~ '^\d+$'
order by (content->>'timestamp')::bigint on conflict do nothing;
update messages m set kind='reaction' from whatsapp_reactions r where m.external=r.account::text||':'||r.event_external;
update conversations c set last_inbound=coalesce((select max(m.created) from messages m where m.conversation=c.id and m.direction='in' and m.kind<>'reaction'),c.last_inbound)
where exists(select 1 from messages m where m.conversation=c.id and m.kind='reaction');
