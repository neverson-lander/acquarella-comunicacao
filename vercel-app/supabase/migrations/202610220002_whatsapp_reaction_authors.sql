alter table whatsapp_reactions add column from_me boolean not null default false;
drop index whatsapp_reactions_target_idx;
create index whatsapp_reactions_target_idx on whatsapp_reactions(tenant,account,customer,target_external,from_me,created desc,received_order desc);

-- Recover reactions previously ignored from the linked phone and QR callbacks.
with contents as (
 select a.id as account,a.tenant,m.value as content,
   coalesce(e.payload->'qrEcho'='true'::jsonb,false) as from_me
 from events e
 cross join lateral jsonb_array_elements(case when jsonb_typeof(e.payload->'entry')='array' then e.payload->'entry' else '[]'::jsonb end) en
 cross join lateral jsonb_array_elements(case when jsonb_typeof(en->'changes')='array' then en->'changes' else '[]'::jsonb end) ch
 cross join lateral jsonb_array_elements(case when jsonb_typeof(ch->'value'->'messages')='array' then ch->'value'->'messages' else '[]'::jsonb end) m
 join accounts a on a.tenant::text=e.tenant and a.channel='whatsapp'
   and a.external=ch->'value'->'metadata'->>'phone_number_id'
 where e.state='done' and m.value->>'type'='reaction'
)
insert into whatsapp_reactions(tenant,account,customer,event_external,target_external,emoji,created,from_me)
select tenant,account,content->>'from',content->>'id',content->'reaction'->>'message_id',
 coalesce(content->'reaction'->>'emoji',''),(content->>'timestamp')::bigint*1000,from_me
from contents where content->'reaction'->>'message_id' is not null
 and content->>'id' is not null and content->>'from' is not null and content->>'timestamp' ~ '^\d{1,12}$'
order by (content->>'timestamp')::bigint
on conflict(account,event_external) do update set from_me=excluded.from_me;
