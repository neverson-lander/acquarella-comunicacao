create table crm_contacts (
  id uuid primary key default gen_random_uuid(), tenant uuid not null references tenants(id),
  name text not null, phone text not null default '', email text not null default '',
  notes text not null default '', name_manual boolean not null default false, created bigint not null
);
create table crm_catalog (
  id uuid primary key default gen_random_uuid(), tenant uuid not null references tenants(id),
  kind text not null check(kind in ('tag','service')), name text not null,
  color text not null default '#25ABBE', active boolean not null default true,
  price_cents bigint not null default 0 check(price_cents>=0), description text not null default '',
  unique(tenant,kind,name)
);
create table crm_opportunities (
  id uuid primary key default gen_random_uuid(), tenant uuid not null references tenants(id),
  conversation uuid not null unique references conversations(id), contact uuid not null references crm_contacts(id),
  stage text not null default 'new' check(stage in ('new','qualified','proposal','scheduled','attended','won','lost')),
  owner uuid references users(id) on delete set null, service uuid references crm_catalog(id),
  offer text not null default '', notes text not null default '', loss_reason text not null default '',
  next_action bigint, first_contact bigint not null, updated bigint not null
);
create table crm_opportunity_tags (
  opportunity uuid not null references crm_opportunities(id), tag uuid not null references crm_catalog(id),
  primary key(opportunity,tag)
);
create table crm_touches (
  id uuid primary key default gen_random_uuid(), tenant uuid not null references tenants(id),
  opportunity uuid not null references crm_opportunities(id), event_key text not null,
  source text not null check(source in ('paid','organic','unknown')),
  evidence text not null check(evidence in ('webhook','manual','legacy')),
  ad_id text not null default '', referral jsonb not null default '{}', created bigint not null,
  unique(opportunity,event_key)
);
create table crm_ads (
  tenant uuid not null references tenants(id), ad_id text not null,
  ad_name text not null default '', adset_id text not null default '', adset_name text not null default '',
  campaign_id text not null default '', campaign_name text not null default '',
  service uuid references crm_catalog(id), offer text not null default '',
  verified boolean not null default false, updated bigint not null,
  primary key(tenant,ad_id)
);
create table crm_events (
  id uuid primary key, tenant uuid not null references tenants(id), opportunity uuid not null references crm_opportunities(id),
  kind text not null check(kind in ('appointment','attendance','sale')),
  occurred bigint not null, amount_cents bigint not null default 0 check(amount_cents>=0),
  actor uuid references users(id) on delete set null, actor_name text not null,
  note text not null default '', attribution jsonb not null default '{}', voided boolean not null default false, created bigint not null
);
create table crm_history (
  id uuid primary key default gen_random_uuid(), tenant uuid not null references tenants(id),
  opportunity uuid not null references crm_opportunities(id), actor_name text not null,
  action text not null, created bigint not null
);
create table crm_settings (tenant uuid primary key references tenants(id), secret text not null);
create index crm_opportunities_tenant_idx on crm_opportunities(tenant,first_contact);
create index crm_touches_opportunity_idx on crm_touches(opportunity,created);
create index crm_events_opportunity_idx on crm_events(opportunity,occurred);
create index crm_history_opportunity_idx on crm_history(opportunity,created);
alter table crm_contacts enable row level security;
alter table crm_catalog enable row level security;
alter table crm_opportunities enable row level security;
alter table crm_opportunity_tags enable row level security;
alter table crm_touches enable row level security;
alter table crm_ads enable row level security;
alter table crm_events enable row level security;
alter table crm_history enable row level security;
alter table crm_settings enable row level security;

insert into crm_contacts(id,tenant,name,phone,created)
select c.id,c.tenant,c.name,case when a.channel='whatsapp' then c.customer else '' end,
coalesce((select min(m.created) from messages m where m.conversation=c.id and m.direction='in'),c.last_inbound)
from conversations c join accounts a on a.id=c.account;
insert into crm_opportunities(tenant,conversation,contact,first_contact,updated)
select c.tenant,c.id,c.id,ct.created,c.updated from conversations c join crm_contacts ct on ct.id=c.id;
insert into crm_touches(tenant,opportunity,event_key,source,evidence,created)
select tenant,id,'legacy','unknown','legacy',first_contact from crm_opportunities;
