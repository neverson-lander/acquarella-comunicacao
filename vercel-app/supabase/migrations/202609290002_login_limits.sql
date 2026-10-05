create table login_limits (
  id text primary key,
  attempts integer not null,
  expires bigint not null
);
create index login_limits_expires_idx on login_limits(expires);
alter table login_limits enable row level security;
