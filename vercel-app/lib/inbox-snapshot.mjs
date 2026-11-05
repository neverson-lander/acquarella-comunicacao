import {canDeleteWhatsAppMessage,canReactWhatsAppMessage} from './message-deletion.mjs';
import {canEditMessage,canForwardMessage} from './message-operation-policy.mjs';

// The caller passes only conversations already filtered by tenant, channel and role.
// Batch the histories so an inbox refresh does not perform six queries per case.
export async function hydrateInbox({pool,user,accounts,conversations,usesQr,messageRows}){
  if(!conversations.length)return;
  const ids=conversations.map(c=>c.id),args=[user.tenant,ids];
  const query=async sql=>(await pool.query(sql,args)).rows;
  const [messages,reactions,deletions,history,evaluations,owners]=await Promise.all([
    messageRows?Promise.resolve(messageRows):query("select m.* from messages m join conversations c on c.id=m.conversation where c.tenant=$1 and c.id=any($2::uuid[]) and m.kind<>'reaction' order by m.created"),
    query(`select * from (select distinct on(c.id,r.target_external,r.from_me)
      c.id as conversation,r.target_external,r.emoji,r.created,r.from_me
      from whatsapp_reactions r join conversations c on c.tenant=r.tenant and c.account=r.account and c.customer=r.customer
      where c.tenant=$1 and c.id=any($2::uuid[]) order by c.id,r.target_external,r.from_me,r.created desc,r.received_order desc) latest where emoji<>''`),
    query(`select c.id as conversation,d.target_external,d.deleted_at,d.actor,d.source
      from whatsapp_deletions d join conversations c on c.tenant=d.tenant and c.account=d.account and c.customer=d.customer
      where c.tenant=$1 and c.id=any($2::uuid[])`),
    query(`select * from (select h.*,row_number() over(partition by conversation order by created desc) as position
      from attendance_history h where tenant=$1 and conversation=any($2::uuid[])) ranked where position<=50 order by created desc`),
    query('select id,conversation,closure,owner,owner_name,state,result,score,rubric,model,error,created,updated from attendance_evaluations where tenant=$1 and conversation=any($2::uuid[]) order by created desc'),
    query('select u.id,u.name from users u where u.tenant=$1 and u.id in (select assigned_to from conversations where tenant=$1 and id=any($2::uuid[]))')
  ]);
  const group=items=>{const map=new Map();for(const item of items){const list=map.get(item.conversation)||[];list.push(item);map.set(item.conversation,list);}return map;};
  const messageGroups=group(messages),reactionGroups=group(reactions),deletionGroups=group(deletions),historyGroups=group(history),evaluationGroups=group(evaluations);
  const accountMap=new Map(accounts.map(a=>[a.id,a])),ownerMap=new Map(owners.map(u=>[u.id,u.name]));
  for(const c of conversations){
    c.messages=messageGroups.get(c.id)||[];
    const reactionMap=new Map(),deletionMap=new Map();
    for(const {conversation,...reaction} of reactionGroups.get(c.id)||[]){const list=reactionMap.get(reaction.target_external)||[];list.push(reaction);reactionMap.set(reaction.target_external,list);}
    for(const {conversation,...deletion} of deletionGroups.get(c.id)||[])deletionMap.set(deletion.target_external,deletion);
    const account=accountMap.get(c.account),qr=usesQr(account);
    for(const m of c.messages){
      const external=m.external?.startsWith(c.account+':')?m.external.slice(c.account.length+1):m.external;
      m.reactions=reactionMap.get(m.external)||reactionMap.get(external)||[];
      m.deletion=deletionMap.get(m.external)||deletionMap.get(external)||null;
      m.can_delete=canDeleteWhatsAppMessage({user,conversation:c,account,message:m,qr});
      m.can_react=canReactWhatsAppMessage({user,conversation:c,account,message:m,qr});
      m.can_forward=canForwardMessage({user,conversation:c,account,message:m,qr});
      m.can_edit=canEditMessage({user,conversation:c,account,message:m,qr});
    }
    c.attendance_history=(historyGroups.get(c.id)||[]).map(({position,...item})=>item);
    c.evaluations=(evaluationGroups.get(c.id)||[]).map(({conversation,...item})=>item);
    c.assignee_name=ownerMap.get(c.assigned_to)||null;
  }
}
