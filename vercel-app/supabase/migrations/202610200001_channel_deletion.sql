-- Keep channel identities for historical conversations, contacts and CRM.
alter table accounts add column deleted_at bigint;
