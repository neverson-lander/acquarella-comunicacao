import {createExternalScheduling} from './external-scheduling.mjs';
import {managesAttendance,seesAttendance,worksAttendance} from './attendance-policy.mjs';
import {automaticPaidTouch} from './crm-domain.mjs';
import {randomUUID} from 'node:crypto';
import {registeredSource,sourceSnapshot} from './registered-source.mjs';
import {ensureConversationCrm} from './crm-conversation.mjs';
import {enqueueEvaluation} from './evaluation-domain.mjs';
const fail=(text,status=400)=>{throw Object.assign(Error(text),{status});};
export function createAttendance({pool,permitted,now=Date.now,resolveExternalScheduling=createExternalScheduling()}){
  async function transact(fn){const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
  async function load(db,user,cid){
    const c=(await db.query('select * from conversations where id=$1 and tenant=$2 for update',[cid,user.tenant])).rows[0];
    if(!c)fail('Atendimento não encontrado.',404);
    const account=(await db.query('select * from accounts where id=$1',[c.account])).rows[0];
    if(account?.deleted_at)fail('Este canal foi excluído. O histórico está disponível apenas para consulta.',410);
    if(!account||!permitted(user,account)||!seesAttendance(user,c))fail('Atendimento indisponível para este usuário.',403);
    return {c,account};
  }
  async function record(db,user,c,action,next,scheduling=null){return (await db.query('insert into attendance_history(tenant,conversation,actor,actor_name,action,previous_owner,next_owner,created,scheduling) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id',[user.tenant,c.id,user.id,user.name,action,c.assigned_to,next,now(),scheduling===null?null:JSON.stringify(scheduling)])).rows[0].id;}
  // Queue membership reflects the current attendance, including returned/reopened conversations.
  const unstarted=`c.status='open' and c.assigned_to is null
    and not exists(select 1 from cashbarber_changes x where x.tenant=c.tenant and x.conversation=c.id and x.state in ('pending','uncertain'))
    and not exists(select 1 from cashbarber_bookings b where b.tenant=c.tenant and b.conversation=c.id and (b.state in ('pending','uncertain') or (b.state='confirmed' and b.closure_id is null)))`;
  const eligibility=scope=>unstarted+(scope==='interactions'?" and not c.attendance_eligible and exists(select 1 from accounts a where a.id=c.account and a.channel='instagram' and a.deleted_at is null)":" and c.attendance_eligible");
  function closeScope(input){const scope=input.scope??'queue';if(!['queue','interactions'].includes(scope))fail('Escopo de encerramento inválido.');return scope;}
  function bulkAccess(user){if(!managesAttendance(user))fail('Apenas administradores e recepcionistas podem encerrar a fila em massa.',403);}
  async function queueClosePreview(user,input={}){
    const scope=closeScope(input);
    bulkAccess(user);
    const accounts=(await pool.query('select * from accounts where tenant=$1',[user.tenant])).rows.filter(a=>permitted(user,a));
    if(!accounts.length)return {items:[],hasMore:false};
    const rows=(await pool.query(`select c.id,c.name,c.account,c.updated,c.last_inbound,(select count(*) from messages m where m.conversation=c.id) as message_count from conversations c where c.tenant=$1 and c.account=any($2::uuid[]) and ${eligibility(scope)} order by c.updated,c.id limit 201`,[user.tenant,accounts.map(a=>a.id)])).rows;
    return {items:rows.slice(0,200).map(c=>({...c,account_name:accounts.find(a=>a.id===c.account).name})),hasMore:rows.length>200};
  }
  async function closeQueue(user,input){
    const scope=closeScope(input);
    bulkAccess(user);const items=Array.isArray(input.items)?input.items.map(i=>i&&typeof i.id==='string'?{...i,id:i.id.toLowerCase()}:i):input.items;
    if(!Array.isArray(items)||items.length<1||items.length>200||new Set(items.map(i=>i?.id)).size!==items.length||items.some(i=>!i||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i.id)||!['updated','last_inbound','message_count'].every(k=>/^\d{1,16}$/.test(String(i[k])))))fail('Selecione entre 1 e 200 atendimentos da consulta atual.');
    const reason=typeof input.reason==='string'?input.reason.trim():'';
    if(!reason||reason.length>1000)fail('Informe o motivo do encerramento em massa (até 1000 caracteres).');
    return transact(async db=>{
      const accounts=(await db.query('select * from accounts where tenant=$1',[user.tenant])).rows.filter(a=>permitted(user,a));
      const allowed=new Set(accounts.map(a=>a.id)),closed=[];
      // Stable lock ordering also serializes claims/transfers and competing batches.
      const conversations=(await db.query('select * from conversations where tenant=$1 and id=any($2::uuid[]) order by id for update',[user.tenant,items.map(i=>i.id)])).rows;
      for(const c of conversations){
        if(!allowed.has(c.account))continue;
        const expected=items.find(i=>i.id===c.id);
        if(String(c.updated)!==String(expected.updated)||String(c.last_inbound)!==String(expected.last_inbound))continue;
        const eligible=(await db.query(`select (select count(*) from messages m where m.conversation=c.id) as message_count from conversations c where c.id=$1 and c.tenant=$2 and ${eligibility(scope)}`,[c.id,user.tenant])).rows[0];
        if(!eligible||String(eligible.message_count)!==String(expected.message_count))continue;
        await db.query("update conversations set status='resolved',updated=$1 where id=$2 and tenant=$3",[now(),c.id,user.tenant]);
        const history=await record(db,user,c,scope==='interactions'?'Interação do Instagram encerrada em massa':'Atendimento encerrado em massa sem início',null);
        await db.query('update attendance_history set reason=$1 where id=$2',[reason,history]);closed.push(c.id);
      }
      if(closed.length)await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,(scope==='interactions'?'Encerramento de interações do Instagram em massa por ':'Encerramento em massa por ')+user.name+': '+closed.length+' atendimento(s). Motivo: '+reason,now()]);
      return {ok:true,closed,skipped:items.length-closed.length};
    });
  }
  async function closeInteraction(user,cid,input){
    if(!['admin','receptionist','agent'].includes(user.role))fail('Seu perfil permite apenas visualizar.',403);
    return transact(async db=>{
      const {c}=await load(db,user,cid);
      if(String(input.updated)!==String(c.updated)||String(input.last_inbound)!==String(c.last_inbound))fail('A interação recebeu uma atualização. Confira as mensagens antes de encerrar.',409);
      const eligible=(await db.query(`select c.id from conversations c where c.id=$1 and c.tenant=$2 and ${eligibility('interactions')}`,[cid,user.tenant])).rows[0];
      if(!eligible)fail('Esta interação já foi encerrada ou se tornou um atendimento. Atualize a lista.',409);
      await db.query("update conversations set status='resolved',updated=$1 where id=$2 and tenant=$3",[now(),cid,user.tenant]);
      await record(db,user,c,'Interação do Instagram encerrada',null);
      await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,'Interação do Instagram encerrada por '+user.name+'.',now()]);
      return {ok:true};
    });
  }
  async function claim(user,cid){
    if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);
    return transact(async db=>{
      const {c,account}=await load(db,user,cid);if(c.status!=='open')fail('Reabra o atendimento antes de assumir.',409);
      if(c.assigned_to&&c.assigned_to!==user.id)fail('O atendimento já foi assumido por outra pessoa.',409);
      if(!permitted(user,account))fail('Sem acesso ao canal.',403);
      if(!c.assigned_to){if(c.attendance_eligible===false){await ensureConversationCrm(db,c,account,now());await db.query('update conversations set attendance_eligible=true where id=$1',[c.id]);}await db.query('update conversations set assigned_to=$1,assigned_at=$2 where id=$3',[user.id,now(),c.id]);await db.query('update crm_opportunities set owner=$1 where conversation=$2',[user.id,c.id]);await record(db,user,c,'Atendimento assumido',user.id);}
      const conversation=(await db.query('select * from conversations where id=$1 and tenant=$2',[c.id,user.tenant])).rows[0];
      conversation.assignee_name=user.name;
      conversation.attendance_history=(await db.query('select * from attendance_history where conversation=$1 and tenant=$2 order by created desc limit 50',[c.id,user.tenant])).rows;
      const opportunity=(await db.query('select * from crm_opportunities where conversation=$1 and tenant=$2',[c.id,user.tenant])).rows[0];
      return {ok:true,conversation,opportunity};
    });
  }
  async function transfer(user,cid,input){
    if(!managesAttendance(user))fail('Apenas administradores e recepcionistas podem transferir.',403);
    return transact(async db=>{
      const {c,account}=await load(db,user,cid);const target=input.assigned_to||null;
      if(target){if(!/^[0-9a-f-]{36}$/i.test(target))fail('Atendente inválido.');const u=(await db.query('select * from users where id=$1 and tenant=$2',[target,user.tenant])).rows[0];if(!u||u.role==='viewer'||!permitted(u,account))fail('Atendente sem acesso a este canal.',403);}
      if(!target&&c.status==='resolved'&&!input.reopen)fail('Reabra o atendimento para devolvê-lo à fila.');
      const status=input.reopen===true?'open':c.status;
      await db.query('update conversations set assigned_to=$1,assigned_at=$2,status=$3,updated=$2 where id=$4',[target,now(),status,c.id]);
      await db.query('update crm_opportunities set owner=$1,updated=$2 where conversation=$3',[target,now(),c.id]);
      await record(db,user,c,(input.reopen===true?'Reaberto e transferido':'Transferido')+(target?'':' para a fila'),target);return {ok:true};
    });
  }
  async function status(user,cid,status,input={}){
    if(!['open','resolved'].includes(status))fail('Status inválido.');
    return transact(async db=>{
      const {c,account}=await load(db,user,cid);
      if(!worksAttendance(user,c)||(status==='resolved'&&!c.assigned_to))fail('Assuma o atendimento antes de alterar o status.',403);
      let scheduling=null,bookings=[];
      if(status==='resolved'){
        if(c.status!=='open')fail('Este atendimento já está finalizado.',409);
        if((await db.query("select id from cashbarber_changes where tenant=$1 and conversation=$2 and state in ('pending','uncertain') limit 1",[user.tenant,c.id])).rows.length)fail('Verifique a alteração ou exclusão pendente antes de encerrar.',409);
        if((await db.query("select id from cashbarber_bookings where tenant=$1 and conversation=$2 and state in ('pending','uncertain') limit 1",[user.tenant,c.id])).rows.length)fail('Verifique o resultado do agendamento pendente na agenda antes de encerrar.',409);
        if(typeof input.had_scheduling!=='boolean')fail('Informe se houve agendamento de serviços antes de encerrar.');
        if(input.scheduling_outcome!==undefined&&input.scheduling_outcome!=='information')fail('Resposta de agendamento inválida.');
        if(input.scheduling_outcome==='information'&&input.had_scheduling)fail('Dúvidas / Informações não pode ser combinado com agendamento.');
        bookings=(await db.query("select id,quote,receipt from cashbarber_bookings where tenant=$1 and conversation=$2 and state='confirmed' and closure_id is null order by created,id for update",[user.tenant,c.id])).rows;
        const bookingIds=input.cash_booking_ids??[];
        if(!Array.isArray(bookingIds)||bookingIds.length!==bookings.length||new Set(bookingIds).size!==bookingIds.length||bookings.some(b=>!bookingIds.includes(b.id)))fail('Os agendamentos foram alterados. Abra o encerramento novamente para conferir.',409);
        if(bookings.length&&!input.had_scheduling)fail('Há serviços confirmados neste atendimento. Confira os agendamentos antes de encerrar.');
        const ids=input.scheduled_services??[];
        if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))fail('Seleção de serviços inválida.');
        if(input.had_scheduling&&!bookings.length&&ids.length)fail('Consulte os serviços da profissional no CashBarber para informar o agendamento.');
        if(!input.had_scheduling&&ids.length)fail('Não selecione serviços quando não houve agendamento.');
        const uniqueIds=[...new Set(ids.map(id=>id.toLowerCase()))];
        const services=uniqueIds.length?(await db.query("select id,name from crm_catalog where tenant=$1 and kind='service' and active and id=any($2::uuid[]) order by name for share",[user.tenant,uniqueIds])).rows:[];
        if(services.length!==uniqueIds.length)fail('Selecione apenas serviços ativos cadastrados nesta empresa.');
        const reported=input.had_scheduling&&!bookings.length?await resolveExternalScheduling(user,input.external_scheduling):null;
        if(!input.had_scheduling&&input.external_scheduling)fail('Não informe agendamentos quando a resposta for Não.');
        const booked=bookings.map(b=>({id:'cashbarber:'+b.id,booking_id:b.id,name:b.quote.service,price_cents:b.quote.price,date:b.quote.date,start:b.quote.start,professional:b.quote.professionalName,client:b.quote.clientName,external_id:b.receipt?.externalId||'',source:'cashbarber'}));
        if(booked.some(b=>!Number.isSafeInteger(b.price_cents)||b.price_cents<0))fail('Agendamento sem valor válido. Confira o registro antes de encerrar.',409);
        scheduling={had_scheduling:input.had_scheduling,...(input.scheduling_outcome==='information'?{outcome:'information'}:{}),services:[...booked,...services,...(reported?.services||[])],...(reported?{external_client:{id:reported.client_id,name:reported.client_name,not_found:reported.client_not_found}}:{}),booked_total_cents:booked.reduce((sum,b)=>sum+b.price_cents,0)};
        const first=(await db.query("select min(created) as created from messages where conversation=$1 and direction='in' and attendance_relevant",[c.id])).rows[0];
        const o=await ensureConversationCrm(db,c,account,first?.created??c.updated);
        const touches=(await db.query('select * from crm_touches where tenant=$1 and opportunity=$2 order by created,id',[user.tenant,o.id])).rows;
        const automatic=automaticPaidTouch({touches});
        if(automatic&&(input.source!=='paid'||input.ad_id!==automatic.ad_id))fail('Origem e anúncio identificados automaticamente não podem ser alterados no encerramento. Abra o encerramento novamente.',409);
        const aid=await registeredSource(db,user.tenant,input);
        const stamp=now();
        const snapshot=await sourceSnapshot(db,user.tenant,o.id,aid);
        if(!automatic)await db.query("insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,referral,created,meta_snapshot) values($1,$2,$3,$4,'manual',$5,$6,$7,$8)",[user.tenant,o.id,randomUUID(),input.source,aid,JSON.stringify({correct_first:true,note:'Origem confirmada no encerramento por '+user.name}),stamp,JSON.stringify(snapshot)]);
        await db.query('insert into crm_history(tenant,opportunity,actor_name,action,created) values($1,$2,$3,$4,$5)',[user.tenant,o.id,user.name,'Origem confirmada no encerramento: '+input.source+(aid?' / anúncio '+aid:''),stamp]);
      }
      await db.query('update conversations set status=$1,updated=$2 where id=$3',[status,now(),c.id]);
      const closureId=await record(db,user,c,status==='open'?'Atendimento reaberto':'Atendimento finalizado',c.assigned_to,scheduling);if(bookings.length)await db.query('update cashbarber_bookings set closure_id=$1 where tenant=$2 and id=any($3::uuid[])',[closureId,user.tenant,bookings.map(b=>b.id)]);
      if(status==='resolved')await enqueueEvaluation(db,{user,c,account,closure:closureId,scheduling,stamp:(await db.query('select created from attendance_history where id=$1',[closureId])).rows[0].created});
      const conversation=(await db.query('select * from conversations where id=$1 and tenant=$2',[c.id,user.tenant])).rows[0];
      conversation.attendance_history=(await db.query('select * from attendance_history where conversation=$1 and tenant=$2 order by created desc limit 50',[c.id,user.tenant])).rows;
      if(account.evaluation_enabled)conversation.evaluations=(await db.query('select id,closure,owner,owner_name,state,result,score,rubric,model,error,created,updated from attendance_evaluations where tenant=$1 and conversation=$2 order by created desc',[user.tenant,c.id])).rows;
      const opportunity=(await db.query('select * from crm_opportunities where conversation=$1 and tenant=$2',[c.id,user.tenant])).rows[0];
      const touches=opportunity?(await db.query('select * from crm_touches where tenant=$1 and opportunity=$2 order by created,id',[user.tenant,opportunity.id])).rows:[];
      const confirmedBookings=(await db.query("select id,conversation,actor,quote,receipt,confirmed_at,closure_id from cashbarber_bookings where tenant=$1 and conversation=$2 and state='confirmed' order by confirmed_at,id",[user.tenant,c.id])).rows;
      return {ok:true,conversation,opportunity,touches,bookings:confirmedBookings};
    });
  }
  return {claim,transfer,status,queueClosePreview,closeQueue,closeInteraction};
}
