alter table accounts add column enabled boolean not null default true;
alter table accounts add column receive_after bigint not null default 0;
alter table crm_contacts add column account uuid references accounts(id);
alter table crm_contacts add column phone_key text not null default '';
alter table crm_contacts add column active boolean not null default true;
alter table crm_contacts add column campaign_excluded boolean not null default false;
alter table crm_contacts add column custom_fields jsonb not null default '{}'::jsonb;
alter table crm_contacts add column updated bigint;
alter table crm_contacts add column created_by uuid references users(id) on delete set null;
alter table crm_contacts add column updated_by uuid references users(id) on delete set null;
update crm_contacts set updated=created;
alter table crm_contacts alter column updated set not null;
alter table crm_contacts alter column updated set default 0;
update crm_contacts c set account=x.account from (
 select o.contact,(array_agg(distinct v.account))[1] as account from crm_opportunities o join conversations v on v.id=o.conversation group by o.contact having count(distinct v.account)=1
) x where x.contact=c.id;

create function contact_phone_key(value text) returns text language sql immutable strict as $$
 with digits as (select regexp_replace(value,'[^0-9]','','g') n), international as (select case when length(n) in (10,11) then '55'||n else n end n from digits)
 select case when n ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then substring(n,1,4)||substring(n,6) when n ~ '^[1-9][0-9]{11,14}$' then n else '' end from international;
$$;
update crm_contacts set phone_key=contact_phone_key(phone);
-- Preserve all historical duplicate records; only the oldest owns the import key.
with ranked as(select id,row_number() over(partition by tenant,account,phone_key order by created,id) n from crm_contacts where account is not null and phone_key<>'')
update crm_contacts c set phone_key='' from ranked r where c.id=r.id and r.n>1;
create unique index crm_contacts_channel_phone on crm_contacts(tenant,account,phone_key) where account is not null and phone_key<>'';
create index crm_contacts_directory on crm_contacts(tenant,active,created,id);
create table crm_contact_fields(id uuid primary key default gen_random_uuid(),tenant uuid not null references tenants(id),name text not null,kind text not null check(kind in ('text','number','date','boolean')),active boolean not null default true,created bigint not null,created_by uuid references users(id) on delete set null);
create unique index crm_contact_fields_name on crm_contact_fields(tenant,lower(name));
create table crm_contact_tags(contact uuid not null references crm_contacts(id) on delete cascade,tag uuid not null references crm_catalog(id),primary key(contact,tag));
insert into crm_contact_tags select distinct o.contact,t.tag from crm_opportunity_tags t join crm_opportunities o on o.id=t.opportunity on conflict do nothing;
create table crm_contact_history(id uuid primary key default gen_random_uuid(),tenant uuid not null references tenants(id),contact uuid not null references crm_contacts(id) on delete cascade,actor uuid references users(id) on delete set null,actor_name text not null,action text not null,before_data jsonb,after_data jsonb,created bigint not null);
create index crm_contact_history_contact on crm_contact_history(tenant,contact,created desc);
alter table crm_contact_fields enable row level security;
alter table crm_contact_tags enable row level security;
alter table crm_contact_history enable row level security;
revoke all on crm_contact_fields,crm_contact_tags,crm_contact_history from public;

create function contact_change_metadata() returns trigger language plpgsql as $$
declare actor_data jsonb; stamp bigint;
begin
 actor_data=coalesce(nullif(current_setting('app.contact_actor',true),''),'{}')::jsonb;
 stamp=(extract(epoch from clock_timestamp())*1000)::bigint;
 if TG_OP='UPDATE' and NEW is not distinct from OLD then return NEW; end if;
 if TG_OP='INSERT' or NEW.phone is distinct from OLD.phone or NEW.account is distinct from OLD.account then NEW.phone_key=contact_phone_key(NEW.phone);end if;
 NEW.updated=stamp;NEW.updated_by=(actor_data->>'id')::uuid;
 if TG_OP='INSERT' then NEW.created_by=(actor_data->>'id')::uuid;end if;
 return NEW;
end;$$;
create trigger contact_metadata before insert or update on crm_contacts for each row execute function contact_change_metadata();
create function contact_change_history() returns trigger language plpgsql as $$
declare actor_data jsonb;
begin
 if TG_OP='UPDATE' and NEW is not distinct from OLD then return NEW;end if;
 actor_data=coalesce(nullif(current_setting('app.contact_actor',true),''),'{}')::jsonb;
 insert into crm_contact_history(tenant,contact,actor,actor_name,action,before_data,after_data,created)
 values(NEW.tenant,NEW.id,(actor_data->>'id')::uuid,coalesce(actor_data->>'name','Sistema'),case when TG_OP='INSERT' then 'Cadastro criado' else 'Cadastro alterado' end,case when TG_OP='UPDATE' then to_jsonb(OLD) else null end,to_jsonb(NEW),NEW.updated);
 return NEW;
end;$$;
create trigger contact_history after insert or update on crm_contacts for each row execute function contact_change_history();
create function contact_tag_history() returns trigger language plpgsql as $$
declare actor_data jsonb;c crm_contacts;item jsonb;cid uuid;tid uuid;stamp bigint;
begin
 cid=case when TG_OP='INSERT' then NEW.contact else OLD.contact end;tid=case when TG_OP='INSERT' then NEW.tag else OLD.tag end;
 select * into c from crm_contacts where id=cid;if not found then return null;end if;
 select jsonb_build_object('id',id,'name',name) into item from crm_catalog where id=tid;
 actor_data=coalesce(nullif(current_setting('app.contact_actor',true),''),'{}')::jsonb;
 stamp=(extract(epoch from clock_timestamp())*1000)::bigint;
 insert into crm_contact_history(tenant,contact,actor,actor_name,action,before_data,after_data,created) values(c.tenant,cid,(actor_data->>'id')::uuid,coalesce(actor_data->>'name','Sistema'),case when TG_OP='INSERT' then 'Tag adicionada' else 'Tag removida' end,case when TG_OP='DELETE' then item else null end,case when TG_OP='INSERT' then item else null end,stamp);
 return null;
end;$$;
create trigger contact_tags_history after insert or delete on crm_contact_tags for each row execute function contact_tag_history();
create table crm_contact_imports(id uuid primary key,tenant uuid not null references tenants(id),actor uuid references users(id) on delete set null,actor_name text not null,digest text not null,result jsonb not null,created bigint not null);
alter table crm_contact_imports enable row level security;
revoke all on crm_contact_imports from public;
create function opportunity_contact_tag() returns trigger language plpgsql as $$
begin
 insert into crm_contact_tags(contact,tag) select contact,NEW.tag from crm_opportunities where id=NEW.opportunity on conflict do nothing;
 return NEW;
end;$$;
create trigger opportunity_contact_tags after insert on crm_opportunity_tags for each row execute function opportunity_contact_tag();
