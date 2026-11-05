import {whatsappCustomerPhone} from './whatsapp-conversation.mjs';
import {randomUUID} from 'node:crypto';
import {canEditMessage,canForwardMessage} from './message-operation-policy.mjs';
import {seesAttendance} from './attendance-policy.mjs';
import {normalizeContactPhone,contactPhoneKey} from '../public/contact-domain.mjs';
import {signedReply} from './sac.mjs';
import {ensureConversationCrm} from './crm-conversation.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const external=(m,a)=>m.external.startsWith(a.id+':')?m.external.slice(a.id.length+1):m.external;
const bodyToSend=m=>m.media?.forwarded||(!m.operator_id&&m.operator_name==='WhatsApp vinculado')?m.body:signedReply(m.signature_name||m.operator_name||'Equipe',m.body);
export function createMessageOperations({pool,permitted,usesQr,qr,attachmentDelivery,now=Date.now}){
 const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
 async function transaction(fn){const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(error){await db.query('rollback');throw error;}finally{db.release();}}
 async function load(user,id,db=pool,lock=false){
  if(!uuid(id))fail('Mensagem inválida.');
  const m=await one(db,'select m.* from messages m join conversations c on c.id=m.conversation where m.id=$1 and c.tenant=$2'+(lock?' for update of m':''),[id,user.tenant]);if(!m)fail('Mensagem não encontrada.',404);
  const c=await one(db,'select * from conversations where id=$1',[m.conversation]);if(!seesAttendance(user,c))fail('Atendimento de outro operador.',403);
  const a=await one(db,'select * from accounts where id=$1 and tenant=$2',[c.account,user.tenant]);if(!a||!permitted(user,a))fail('Sem acesso ao canal.',403);
  m.deletion=await one(db,"select deleted_at from whatsapp_deletions where tenant=$1 and account=$2 and customer=$3 and (target_external=$4 or $2::text||':'||target_external=$4) limit 1",[user.tenant,a.id,c.customer,m.external]);
  return {m,c,a,policy:{user,conversation:c,account:a,message:m,qr:usesQr(a)}};
 }
 async function context(user,id){
  const {m,c,a,policy}=await load(user,id);
  const pending=await one(pool,"select id,kind,state,input,error,updated from message_operations where tenant=$1 and source_message=$2 and actor=$3 and state in ('sending','uncertain') order by created desc limit 1",[user.tenant,id,user.id]);
  return {message:m,account:{id:a.id,name:a.name,channel:a.channel},canEdit:canEditMessage(policy,now()),canForward:canForwardMessage(policy),forwardBody:m.direction==='out'&&m.operator_id&&!m.media?.forwarded&&(m.kind||'text')==='text'?bodyToSend(m):(m.media?.caption||m.body),pending,conversation:c.id};
 }
 async function targets(user,id,params){
  const {a,policy}=await load(user,id);if(!canForwardMessage(policy))fail('Assuma o atendimento em um WhatsApp QR ativo para encaminhar.',403);
  const q=(params.get('q')||'').trim();if(q.length<2||q.length>100)fail('Digite entre 2 e 100 caracteres para pesquisar.');
  const digits=q.replace(/\D/g,''),needle=q.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const items=(await pool.query("select id,name,phone from crm_contacts where tenant=$1 and account=$2 and active and phone<>'' and (position($3 in translate(lower(name),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'))>0 or ($4<>'' and position($4 in phone)>0)) order by name,id limit 21",[user.tenant,a.id,needle,digits])).rows;
  return {items:items.slice(0,20),hasMore:items.length>20};
 }
 async function inputFor(user,kind,input,{m,a},db,allowSame=false){
  if(kind==='edit'){
   if(typeof input.body!=='string'||!input.body.trim())fail('Escreva o texto atualizado.');const body=input.body.trim();
   if(body.length>2000)fail('Use até 2.000 caracteres.');if(!allowSame&&body===m.body)fail('Altere o texto antes de salvar.');
   try{bodyToSend({...m,body});}catch(error){fail(error.message);}
   return {body,expected_body:input.expected_body,expected_edit:Number(input.expected_edit||0)};
  }
  let contact;
  if(input.contact){if(!uuid(input.contact))fail('Contato inválido.');contact=await one(db,'select * from crm_contacts where id=$1 and tenant=$2 and account=$3',[input.contact,user.tenant,a.id]);if(!contact||!contact.active)fail('Contato indisponível neste canal.',403);}
  const phone=normalizeContactPhone(contact?.phone||input.phone||'');
  if(!contact)contact=await one(db,'select * from crm_contacts where tenant=$1 and account=$2 and phone_key=$3',[user.tenant,a.id,contactPhoneKey(phone)]);
  if(contact&&!contact.active)fail('Cliente desativado. Reative o cadastro antes de encaminhar.',409);
  return {phone,name:contact?.name||'+'+phone,contact:input.contact?contact.id:null,expected_body:input.expected_body,expected_edit:Number(input.expected_edit||0)};
 }
 async function reserve(user,id,kind,input){
  if(!uuid(input.id))fail('Identificador da ação inválido.');
  return transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['message-action:'+input.id]);
   const context=await load(user,id,db,true),{m,c,a,policy}=context;
   const old=await one(db,'select * from message_operations where id=$1',[input.id]),prepared=await inputFor(user,kind,input,context,db,!!old);
   if(old){
    if(old.tenant!==user.tenant||old.actor!==user.id||old.kind!==kind||old.source_message!==id||Object.keys(prepared).some(k=>k!=='name'&&old.input[k]!==prepared[k]))fail('Identificador já utilizado para outra ação.',409);
    if(old.state==='sent'||old.state==='failed'||old.state==='sending'&&now()-Number(old.updated)<65000)return {operation:old,owner:false,context};
    if(kind==='edit'?!canEditMessage(policy,now()):!canForwardMessage(policy))fail('A ação não está mais disponível neste atendimento. Confira o WhatsApp antes de repetir.',403);
    await db.query("update message_operations set state='sending',updated=$2 where id=$1",[old.id,now()]);return {operation:{...old,state:'sending'},owner:true,context};
   }
   if(kind==='edit'?!canEditMessage(policy,now()):!canForwardMessage(policy))fail(kind==='edit'?'A edição está disponível para textos enviados por você há menos de 15 minutos em um atendimento WhatsApp QR ativo.':'Assuma o atendimento em um WhatsApp QR ativo para encaminhar.',403);
   if(input.expected_body!==m.body||Number(input.expected_edit||0)!==Number(m.media?.edited?.at||0))fail('A mensagem foi alterada. Abra a ação novamente para conferir.',409);
   if(kind==='edit'&&await one(db,"select id from message_operations where source_message=$1 and kind='edit' and state='sending' limit 1",[id]))fail('Uma edição desta mensagem já está em andamento. Aguarde a confirmação.',409);
   const stamp=now();let target=c,mid=null;
   if(kind==='forward'){
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['message-forward:'+a.id+':'+contactPhoneKey(prepared.phone)]);
    const candidates=(await db.query("select * from conversations where tenant=$1 and account=$2 and (customer=$3 or (case when customer ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then substring(customer,1,4)||substring(customer,6) else customer end)=$4) order by updated desc for update",[user.tenant,a.id,prepared.phone,contactPhoneKey(prepared.phone)])).rows;
    if(candidates.length>1)fail('Há conversas duplicadas para este número. Abra o destino pela caixa de entrada.',409);
    target=candidates[0];if(target?.status==='open'&&target.assigned_to&&target.assigned_to!==user.id)fail('Este cliente está em atendimento com outra pessoa. Solicite a transferência antes de encaminhar.',409);
    if(!target)target=await one(db,"insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,$5,'open',$6,0) returning *",[randomUUID(),user.tenant,a.id,whatsappCustomerPhone(prepared.phone),prepared.name,stamp]);
    const opportunity=await ensureConversationCrm(db,target,a,stamp);
    if(prepared.contact&&opportunity.contact!==prepared.contact)fail('O cadastro do destino mudou. Pesquise novamente.',409);
    if(target.status!=='open'||target.assigned_to!==user.id)await db.query("insert into attendance_history(tenant,conversation,actor,actor_name,action,previous_owner,next_owner,created) values($1,$2,$3,$4,$5,$6,$3,$7)",[user.tenant,target.id,user.id,user.name,target.status==='resolved'?'Reaberto por encaminhamento':'Atendimento assumido',target.assigned_to,stamp]);
    await db.query("update conversations set status='open',attendance_eligible=true,assigned_to=$1,assigned_at=case when assigned_to is distinct from $1 or status<>'open' then $2 else assigned_at end,updated=$2 where id=$3",[user.id,stamp,target.id]);
    await db.query('update crm_opportunities set owner=$1,updated=$2 where id=$3',[user.id,stamp,opportunity.id]);
    mid=randomUUID();const {replyTo,edited,...media}=m.media||{};
    const body=m.direction==='out'&&m.operator_id&&!m.media?.forwarded&&(m.kind||'text')==='text'?bodyToSend(m):m.body;
    await db.query("insert into messages(id,conversation,direction,body,kind,media,created,state,operator_id,operator_name) values($1,$2,'out',$3,$4,$5,$6,'queued',$7,$8)",[mid,target.id,body,m.kind||'text',JSON.stringify({...media,forwarded:{source:id,at:stamp,actor:user.id}}),stamp,user.id,user.name]);
   }
   const snapshot={body:m.body,media:m.media,external:external(m,a),kind:m.kind||'text',customer:c.customer,fromMe:m.direction==='out',operator_id:m.operator_id,operator_name:m.operator_name,signature_name:m.signature_name};
   const operation=await one(db,"insert into message_operations(id,tenant,kind,source_message,actor,actor_name,input,snapshot,target_conversation,target_message,state,created,updated) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sending',$11,$11) returning *",[input.id,user.tenant,kind,id,user.id,user.name,JSON.stringify(prepared),JSON.stringify(snapshot),target.id,mid,stamp]);
   return {operation,owner:true,context};
  });
 }
 async function result(user,operation){
  const messageId=operation.kind==='edit'?operation.source_message:operation.target_message;
  const m=await one(pool,'select * from messages where id=$1',[messageId]);const c=await one(pool,'select c.*,u.name as assignee_name from conversations c left join users u on u.id=c.assigned_to where c.id=$1 and c.tenant=$2',[m.conversation,user.tenant]);
  const a=await one(pool,'select * from accounts where id=$1',[c.account]),policy={user,conversation:c,account:a,message:m,qr:usesQr(a)};
  m.can_edit=canEditMessage(policy,now());m.can_forward=canForwardMessage(policy);
  const opportunity=operation.kind==='forward'?await one(pool,'select * from crm_opportunities where tenant=$1 and conversation=$2',[user.tenant,c.id]):null;
  const contact=opportunity?await one(pool,'select * from crm_contacts where id=$1 and tenant=$2',[opportunity.contact,user.tenant]):null;
  const touches=opportunity?(await pool.query('select * from crm_touches where tenant=$1 and opportunity=$2 order by created,id',[user.tenant,opportunity.id])).rows:undefined;
  const tags=opportunity?(await pool.query('select * from crm_opportunity_tags where opportunity=$1',[opportunity.id])).rows:undefined;
  if(opportunity)Object.assign(opportunity,{account:c.account,customer:c.customer,customer_name:c.name,assigned_to:c.assigned_to,status:c.status,channel:a.channel,mode:a.mode,owner_name:c.assignee_name});
  return {ok:operation.state==='sent',id:operation.id,kind:operation.kind,state:operation.state,error:operation.error,message:m,target:c,opportunity,contact,touches,tags};
 }
 async function perform(user,id,kind,input){
  const reservation=await reserve(user,id,kind,input);let {operation}=reservation;
  if(!reservation.owner)return result(user,operation);
  const {a}=reservation.context,snapshot=operation.snapshot;let delivered,state='sent',error='';
  try{
   if(kind==='edit')delivered=await qr.edit(a,{recipient:snapshot.customer,external:snapshot.external,body:bodyToSend({...snapshot,body:operation.input.body}),idempotencyKey:'edit:'+operation.id});
   else{
    const media=snapshot.media||{};let delivery;
    if(media.attachmentId){const available=await attachmentDelivery(media.attachmentId);delivery={url:available.url,kind:available.item.kind,mime:available.item.mime,name:available.item.name};}
    const body=snapshot.fromMe&&snapshot.operator_id&&!media.forwarded&&snapshot.kind==='text'?bodyToSend(snapshot):snapshot.body;
    delivered=await qr.forward(a,{recipient:operation.input.phone,source:{external:snapshot.external,customer:snapshot.customer,fromMe:snapshot.fromMe,kind:snapshot.kind,body,qrId:media.qrId,mime:media.mime_type,name:media.name,caption:media.caption||(!/^\[.*\]$/.test(snapshot.body)?snapshot.body:''),...(delivery?{delivery}:{})},idempotencyKey:'forward:'+operation.id});
   }
   if(!delivered?.ok||!delivered.external)throw Object.assign(Error('O WhatsApp não confirmou a ação.'),{definite:false});
  }catch(cause){state=cause.definite===true||cause.status&&cause.status<500&&cause.definite!==false?'failed':'uncertain';error=String(cause.message||cause).slice(0,500);}
  operation=await transaction(async db=>{
   const current=await one(db,'select * from message_operations where id=$1 for update',[operation.id]);if(current.state==='sent')return current;
   if(kind==='edit'&&state==='sent')await db.query("update messages set body=$2,media=media||$3::jsonb where id=$1",[operation.source_message,operation.input.body,JSON.stringify({edited:{at:now(),actor:user.id,name:user.name}})]);
   if(kind==='forward')await db.query('update messages set state=$2,external=$3 where id=$1',[operation.target_message,state,delivered?.external||null]);
   if(state==='sent')await db.query('update conversations set updated=$2 where id=$1',[operation.target_conversation,now()]);
   await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,(kind==='edit'?'Edição':'Encaminhamento')+' de mensagem por '+user.name+': '+state+'.',now()]);
   return one(db,'update message_operations set state=$2,error=$3,external=$4,updated=$5 where id=$1 returning *',[operation.id,state,error,delivered?.external||null,now()]);
  });
  return result(user,operation);
 }
 async function history(user,id){await load(user,id);return {items:(await pool.query("select actor_name,created,updated,state,snapshot->>'body' as previous_body,input->>'body' as body from message_operations where tenant=$1 and source_message=$2 and kind='edit' order by created desc limit 50",[user.tenant,id])).rows};}
 return {context,targets,perform,history};
}
