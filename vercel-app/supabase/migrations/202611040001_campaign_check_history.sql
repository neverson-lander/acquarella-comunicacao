-- Keep one durable result for every attendance/ad reference. The legacy table
-- remains available for old application versions during deployment/rollback.
create table cashbarber_campaign_check_history (
 tenant uuid not null references tenants(id),
 conversation uuid not null references conversations(id) on delete cascade,
 ad_id text not null,
 since bigint not null,
 report jsonb not null,
 actor uuid references users(id) on delete set null,
 checked_at bigint not null,
 primary key(tenant,conversation,ad_id,since)
);
insert into cashbarber_campaign_check_history(tenant,conversation,ad_id,since,report,actor,checked_at)
select tenant,conversation,ad_id,coalesce((report->>'since')::bigint,0),report,actor,checked_at
from cashbarber_campaign_checks;
alter table cashbarber_campaign_check_history enable row level security;
revoke all on cashbarber_campaign_check_history from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on cashbarber_campaign_check_history from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on cashbarber_campaign_check_history from authenticated; end if;
end $$;
