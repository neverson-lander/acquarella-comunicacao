create index if not exists conversations_finalized_page_idx
  on conversations(tenant,updated desc,id desc) where status='resolved';
create index if not exists messages_conversation_page_idx
  on messages(conversation,created desc,id desc);
