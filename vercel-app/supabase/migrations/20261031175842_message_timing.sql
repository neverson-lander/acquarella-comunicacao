-- Leave historical arrivals unknown; created is the provider's send time.
alter table messages add column if not exists received_at bigint;
