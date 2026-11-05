create table cashbarber_contact_links (
 tenant uuid not null references tenants(id) on delete cascade,
 account uuid not null references accounts(id) on delete cascade,
 client_id text not null,
 contact uuid not null references crm_contacts(id) on delete cascade,
 updated bigint not null,
 primary key(tenant,account,client_id)
);
create index cashbarber_contact_links_contact on cashbarber_contact_links(tenant,contact);
alter table cashbarber_contact_links enable row level security;
