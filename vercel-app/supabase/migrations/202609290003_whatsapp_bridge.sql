create table bridge_windows(
  account uuid not null references accounts(id) on delete cascade,
  phone text not null,
  seen bigint not null,
  primary key(account,phone)
);

create table receipts(
  account uuid not null references accounts(id) on delete cascade,
  external text not null,
  primary key(account,external)
);

alter table bridge_windows enable row level security;
alter table receipts enable row level security;
