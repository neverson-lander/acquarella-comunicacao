alter table users add column if not exists appearance text not null default 'original'
  check (appearance in ('original','petrol','sage','graphite'));
