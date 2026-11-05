alter table cashbarber_bookings add column closure_id uuid references attendance_history(id);
alter table cashbarber_bookings add column confirmed_at bigint;
update cashbarber_bookings set confirmed_at=updated where state='confirmed';
create index cashbarber_bookings_unclosed on cashbarber_bookings(tenant,conversation,created) where state='confirmed' and closure_id is null;

-- A confirmed reservation is a historical quote, never a live catalogue price.
create function preserve_cashbarber_quote() returns trigger language plpgsql as $$
begin
  if TG_OP='UPDATE' and OLD.state='confirmed' and
    (NEW.quote is distinct from OLD.quote or NEW.confirmed_at is distinct from OLD.confirmed_at) then
    raise exception 'O serviço e o valor de um agendamento confirmado não podem ser alterados.';
  end if;
  if NEW.state='confirmed' and NEW.confirmed_at is null then NEW.confirmed_at=NEW.updated; end if;
  return NEW;
end;
$$;
create trigger cashbarber_quote_snapshot before insert or update on cashbarber_bookings for each row execute function preserve_cashbarber_quote();
