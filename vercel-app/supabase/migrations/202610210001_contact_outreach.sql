create table contact_outreach (
  id uuid primary key, tenant uuid not null references tenants(id),
  contact uuid not null references crm_contacts(id), account uuid not null references accounts(id),
  conversation uuid not null references conversations(id), actor uuid references users(id) on delete set null,
  message uuid not null unique references messages(id), body text not null, created bigint not null
);
create index contact_outreach_contact_idx on contact_outreach(tenant,contact,created);
alter table contact_outreach enable row level security;
