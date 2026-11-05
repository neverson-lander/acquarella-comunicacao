create table public.mercado_pago_settings (
  tenant uuid not null references public.tenants(id) on delete cascade,
  environment text not null check (environment in ('test', 'production')),
  access_token text,
  webhook_secret text,
  links_enabled boolean not null default false,
  check (not links_enabled or (environment = 'production' and access_token is not null)),
  primary key (tenant, environment)
);

alter table public.mercado_pago_settings enable row level security;
revoke all on public.mercado_pago_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.mercado_pago_settings from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.mercado_pago_settings from authenticated;
  end if;
end $$;

create table public.mercado_pago_renewals (
  tenant uuid not null references public.tenants(id) on delete cascade,
  subscription text not null,
  due_date date not null,
  request_id uuid not null unique,
  cents integer not null check (cents > 0),
  order_id text,
  checkout_url text,
  primary key (tenant, subscription, due_date)
);

alter table public.mercado_pago_renewals enable row level security;
revoke all on public.mercado_pago_renewals from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.mercado_pago_renewals from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.mercado_pago_renewals from authenticated;
  end if;
end $$;
