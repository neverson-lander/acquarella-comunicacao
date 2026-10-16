alter table accounts add column service_hours jsonb not null default '{"enabled":false,"timezone":"America/Sao_Paulo","days":[[],[{"start":"09:00","end":"18:00"}],[{"start":"09:00","end":"18:00"}],[{"start":"09:00","end":"18:00"}],[{"start":"09:00","end":"18:00"}],[{"start":"09:00","end":"18:00"}],[]]}'::jsonb;
alter table accounts add column forwarding_phone text not null default '';
alter table accounts add column forwarding_period text not null default 'always' check(forwarding_period in ('always','inside','outside'));
-- Existing channels retain their forwarding behavior and the tenant's fallback
-- phone. The existing accounts RLS and tenant authorization remain in effect.
