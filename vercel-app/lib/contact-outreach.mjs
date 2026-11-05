import {whatsappCustomerPhone} from './whatsapp-conversation.mjs';
import {randomUUID} from 'node:crypto';
import {contactPhoneKey} from '../public/contact-domain.mjs';
import {sameWhatsAppPhone} from './whatsapp-phone.mjs';
import {ensureConversationCrm} from './crm-conversation.mjs';
import {signedReply} from './sac.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export function createContactOutreach({pool,permitted,requiresWindow,now=Date.now}){
  const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
  function access(user){if(!['admin','receptionist','agent'].includes(user.role))fail('Seu perfil permite apenas visualizar.',403);}
  async function load(db,user,id,lock=false){
    if(!uuid(id))fail('Cliente inválido.');
    const contact=await one(db,'select * from crm_contacts where id=$1 and tenant=$2',[id,user.tenant]);
    if(!contact)fail('Cliente não encontrado.',404);
    const account=await one(db,`select * from accounts where id=$1 and tenant=$2 ${lock?'for share':''}`,[contact.account,user.tenant]);
    if(!account||!permitted(user,account)||account.deleted_at)fail('Canal do cliente indisponível para seu acesso.',403);
    // Find by the provider identity as well as the CRM link; this also recovers phone echoes.
    const conversations=(await db.query(`select c.* from conversations c where c.tenant=$1 and c.account=$2 and
      (exists(select 1 from crm_opportunities o where o.conversation=c.id and o.contact=$3) or ($4<>'' and c.customer=$4) or
        ($5<>'' and (case when c.customer ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then substring(c.customer,1,4)||substring(c.customer,6) else c.customer end)=$5)) order by c.updated desc,c.id ${lock?'for update of c':''}`,
      [user.tenant,account.id,contact.id,account.channel==='whatsapp'?contact.phone:'',account.channel==='whatsapp'?contactPhoneKey(contact.phone):''])).rows;
    if(conversations.length>1)fail('Há mais de uma conversa para este cliente. Abra o atendimento pela caixa de entrada.',409);
    return {contact,account,conversation:conversations[0]};
  }
  function unavailable(user,{contact,account,conversation}){
    if(!contact.active)return 'Cliente desativado. Reative o cadastro antes de enviar.';
    if(account.enabled===false||account.mode!=='live')return 'Ative um canal real para enviar mensagens.';
    if(conversation?.customer?.startsWith('demo-'))return 'Conversa demonstrativa não permite envio real.';
    if(conversation?.status==='open'&&conversation.assigned_to&&conversation.assigned_to!==user.id)return 'Cliente em atendimento com outro responsável. Solicite a transferência antes de enviar.';
    if(account.channel==='whatsapp'&&!/^\d{10,15}$/.test(contact.phone))return 'Cadastre um telefone válido para este cliente.';
    if(account.channel==='whatsapp'&&sameWhatsAppPhone(contact.phone,account.external))return 'O destino é o próprio número do canal.';
    if(account.channel!=='whatsapp'&&!conversation)return 'Este canal precisa de uma conversa iniciada pelo cliente. Não é possível enviar usando somente o telefone.';
    if(requiresWindow(account)&&(!conversation?.last_inbound||now()-Number(conversation.last_inbound)>=86400000))return 'A janela de 24 horas deste canal está fechada. Aguarde uma mensagem do cliente; envio por modelo aprovado ainda não está disponível na central.';
    return '';
  }
  function safe(user,context){const {contact:c,account:a,conversation:v}=context,reason=unavailable(user,context);return {id:c.id,name:c.name,phone:c.phone,email:c.email,account:{id:a.id,name:a.name,channel:a.channel},conversation:v?.id||null,canSend:!reason,reason};}
  async function preview(user,id){access(user);return safe(user,await load(pool,user,id));}
  async function search(user,params){
    access(user);const q=(params.get('q')||'').trim(),account=params.get('account')||'';
    if(q.length<2||q.length>150)fail('Digite entre 2 e 150 caracteres para buscar o cliente.');
    if(account&&!uuid(account))fail('Canal inválido.');
    const accounts=(await pool.query('select * from accounts where tenant=$1 and deleted_at is null',[user.tenant])).rows.filter(a=>permitted(user,a));
    const allowed=accounts.filter(a=>!account||a.id===account).map(a=>a.id);
    const needle='%'+q.replace(/[\\%_]/g,'\\$&')+'%',digits=q.replace(/\D/g,'');
    const contacts=(await pool.query(`select c.id from crm_contacts c where c.tenant=$1 and c.active and c.account=any($2::uuid[])
      and (c.name ilike $3 escape '\\' or c.email ilike $3 escape '\\' or ($4<>'' and c.phone like '%'||$4||'%')) order by c.name,c.id limit 31`,[user.tenant,allowed,needle,digits])).rows;
    const items=[];for(const c of contacts.slice(0,30)){try{items.push(await preview(user,c.id));}catch(e){if(e.status!==409)throw e;}}
    return {items,hasMore:contacts.length>30,accounts:accounts.map(a=>({id:a.id,name:a.name,channel:a.channel}))};
  }
  async function result(user,id){
    access(user);const r=await one(pool,`select r.conversation,r.message,m.state,j.error from contact_outreach r join messages m on m.id=r.message
      left join jobs j on j.id=r.id where r.id=$1 and r.tenant=$2 and r.actor=$3`,[id,user.tenant,user.id]);
    if(!r)fail('Envio não encontrado.',404);return {ok:true,...r};
  }
  async function enqueue(user,input){
    access(user);if(!uuid(input.id)||!uuid(input.contact))fail('Solicitação de envio inválida.');
    if(typeof input.body!=='string'||!input.body.trim()||input.body.length>2000)fail('Escreva uma mensagem de até 2.000 caracteres.');
    const body=input.body.trim();let signed;try{signed=signedReply(user.name,body);}catch(e){fail(e.message);}
    const db=await pool.connect();
    try{
      await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['outreach:'+input.id]);
      const old=await one(db,'select * from contact_outreach where id=$1',[input.id]);
      if(old){if(old.tenant!==user.tenant||old.actor!==user.id||old.contact!==input.contact||old.body!==body)fail('Identificador de envio já utilizado.',409);await load(db,user,input.contact);await db.query('commit');return;}
      // Serialize two operators initiating the same registered client before a conversation exists.
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['outreach-contact:'+user.tenant+':'+input.contact]);
      const latest=await load(db,user,input.contact,true),{contact,account}=latest,reason=unavailable(user,latest);if(reason)fail(reason,409);
      let c=latest.conversation;const stamp=now();
      if(!c)c=await one(db,"insert into conversations(id,tenant,account,customer,name,name_manual,status,updated,last_inbound) values($1,$2,$3,$4,$5,true,'open',$6,0) on conflict(account,customer) do update set customer=conversations.customer returning *",[randomUUID(),user.tenant,account.id,whatsappCustomerPhone(contact.phone),contact.name,stamp]);
      // A concurrent inbound webhook may have created or claimed the conversation.
      const locked=await one(db,'select * from conversations where id=$1 and tenant=$2 for update',[c.id,user.tenant]);
      const blocked=unavailable(user,{contact,account,conversation:locked});if(blocked)fail(blocked,409);c=locked;
      const first=(await one(db,"select min(created) as created from messages where conversation=$1 and direction='in'",[c.id])).created;
      const o=await ensureConversationCrm(db,c,account,first??stamp);
      // Lock the directory row after CRM identity locks, matching inbound capture order.
      const verified=await one(db,'select * from crm_contacts where id=$1 and tenant=$2 for share',[contact.id,user.tenant]);
      if(!verified||verified.account!==account.id||verified.phone!==contact.phone||!verified.active||o.contact!==contact.id)fail('O cadastro do cliente mudou. Abra o envio novamente para conferir.',409);
      const changed=c.status!=='open'||c.assigned_to!==user.id;
      await db.query("update conversations set status='open',attendance_eligible=true,assigned_to=$1,assigned_at=case when assigned_to is distinct from $1 or status<>'open' then $2 else assigned_at end,updated=$2 where id=$3",[user.id,stamp,c.id]);
      await db.query('update crm_opportunities set owner=$1,updated=$2 where id=$3',[user.id,stamp,o.id]);
      if(changed)await db.query("insert into attendance_history(tenant,conversation,actor,actor_name,action,previous_owner,next_owner,created) values($1,$2,$3,$4,$5,$6,$3,$7)",[user.tenant,c.id,user.id,user.name,c.status==='resolved'?'Reaberto por envio ativo':'Atendimento assumido',c.assigned_to,stamp]);
      const mid=randomUUID();
      await db.query("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name) values($1,$2,'out',$3,$4,'queued',$5,$6)",[mid,c.id,body,stamp,user.id,user.name]);
      await db.query("insert into jobs(id,tenant,account,conversation,message,kind,recipient,body,state,error,created) values($1,$2,$3,$4,$5,'reply',$6,$7,'pending','',$8)",[input.id,user.tenant,account.id,c.id,mid,c.customer,signed,stamp]);
      await db.query('insert into contact_outreach(id,tenant,contact,account,conversation,actor,message,body,created) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[input.id,user.tenant,contact.id,account.id,c.id,user.id,mid,body,stamp]);
      await db.query("insert into crm_history(tenant,opportunity,actor_name,action,created) values($1,$2,$3,'Envio ativo iniciado pelo cadastro do cliente',$4)",[user.tenant,o.id,user.name,stamp]);
      await db.query('commit');
    }catch(e){await db.query('rollback');throw e;}finally{db.release();}
  }
  return {search,preview,enqueue,result};
}
