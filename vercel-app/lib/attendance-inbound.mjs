export async function reopenInbound(run,conversation,stamp,inbound){
  await run(`with previous as (
    select id,tenant,status,assigned_to from conversations where id=$1 for update
  ), changed as (
    update conversations c set updated=$2,last_inbound=greatest(c.last_inbound,$3),status='open',
      assigned_to=case when p.status='resolved' then null else c.assigned_to end,
      assigned_at=case when p.status='resolved' then null else c.assigned_at end
    from previous p where c.id=p.id
    returning c.id,c.tenant,p.status as previous_status,p.assigned_to as previous_owner
  ), owner_sync as (
    update crm_opportunities o set owner=null,updated=$2 from changed c
    where o.conversation=c.id and c.previous_status='resolved' returning o.id
  ) insert into attendance_history(tenant,conversation,actor_name,action,previous_owner,next_owner,created)
    select tenant,id,'Sistema','Nova mensagem após encerramento: devolvido à fila',previous_owner,null,$2
    from changed where previous_status='resolved'`,[conversation.id,stamp,inbound]);
}
