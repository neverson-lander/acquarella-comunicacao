create table quick_reply_assets (
 id uuid primary key,
 tenant uuid not null references tenants(id) on delete cascade,
 uploader uuid not null references users(id),
 name text not null,
 mime text not null check(mime in ('image/jpeg','image/png')),
 size integer not null check(size between 1 and 5242880),
 ready boolean not null default false,
 created bigint not null,
 unique(tenant,id)
);
create table quick_reply_parts (
 asset uuid not null references quick_reply_assets(id) on delete cascade,
 part integer not null check(part>=0),
 secret text not null,
 primary key(asset,part)
);
create table quick_replies (
 id uuid primary key,
 tenant uuid not null references tenants(id) on delete cascade,
 name text not null check(length(name) between 1 and 100),
 body text not null check(length(body)<=1800),
 asset uuid,
 version integer not null default 1,
 created bigint not null,
 updated bigint not null,
 foreign key(tenant,asset) references quick_reply_assets(tenant,id),
 check(length(trim(body))>0 or asset is not null)
);
create unique index quick_replies_name on quick_replies(tenant,lower(name));
create index quick_reply_assets_owner on quick_reply_assets(tenant,uploader,created);
alter table quick_replies enable row level security;
alter table quick_reply_assets enable row level security;
alter table quick_reply_parts enable row level security;
