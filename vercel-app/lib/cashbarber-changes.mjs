import {randomUUID} from 'node:crypto';
import {cashError,externalId} from './cashbarber-domain.mjs';
import {canReplyAttendance} from './attendance-policy.mjs';
export function createCashbarberChanges({pool,client,audit}){
 const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
 async function finish(user,change,result){
  if(!['confirmed','rejected','uncertain'].includes(result.state)||result.kind!==change.kind||String(result.externalId)!==change.external_id)result={state:'uncertain',kind:change.kind,externalId:change.external_id,message:'Resposta não reconhecida. Verifique o resultado antes de repetir.'};
  const db=await pool.connect();try{
   await db.query('begin');const current=await one(db,'select * from cashbarber_changes where id=$1 and tenant=$2 for update',[change.id,user.tenant]);
   if(current.state==='confirmed'){await db.query('commit');return current.result;}
   if(result.state==='confirmed'){
    const before=change.preview.before,after=result.after;
    if(change.kind==='update'&&(!after||after.clientId!==change.client_id||String(after.id)!==change.external_id||!Array.isArray(after.services)||!after.services.length||!Number.isSafeInteger(after.price)))throw cashError('A alteração exige nova verificação de dados e valores.',409);
    await db.query("update cashbarber_bookings set state=$1,updated=$2 where tenant=$3 and state='confirmed' and receipt->>'externalId'=$4",[change.kind==='cancel'?'cancelled':'rescheduled',Date.now(),user.tenant,change.external_id]);
    if(change.kind==='update'){
     const quote={clientId:after.clientId,clientName:after.clientName||before.clientName,professionalId:after.professionalId,professionalName:after.professionalName,date:after.date,start:after.start,end:after.end,price:after.price,service:after.services.map(s=>s.name).join(' + '),serviceId:after.services.length===1?after.services[0].id:undefined,services:after.services,branchId:after.branchId};
     const stamp=Date.now();await db.query("insert into cashbarber_bookings(id,tenant,conversation,actor,state,quote,receipt,created,updated,expires) values($1,$2,$3,$4,'confirmed',$5,$6,$7,$7,$7)",[change.id,user.tenant,change.conversation,user.id,JSON.stringify(quote),JSON.stringify({externalId:change.external_id,message:'Agendamento alterado pela central.',change:change.id}),stamp]);
    }
    // Keep prior campaign evidence while removing stale reservations from current totals.
    await db.query("update cashbarber_campaign_checks set report=report || jsonb_build_object('invalidated_matches',report->'matches','matches','[]'::jsonb,'status','inconclusive','total_amount_cents',null,'invalidation_reason','Agendamento alterado ou excluído pela central; consulte novamente.') where tenant=$1 and exists(select 1 from jsonb_array_elements(report->'matches') m where m->>'id'=$2)",[user.tenant,change.external_id]);
    await db.query("insert into attendance_history(tenant,conversation,actor,actor_name,action,created) values($1,$2,$3,$4,$5,$6)",[user.tenant,change.conversation,user.id,user.name,(change.kind==='cancel'?'Agendamento excluído no CashBarber':'Agendamento alterado no CashBarber')+' · Registro '+change.external_id,Date.now()]);
   }
   await db.query('update cashbarber_changes set state=$1,result=$2,updated=$3 where id=$4 and tenant=$5',[result.state,JSON.stringify(result),Date.now(),change.id,user.tenant]);
   await db.query('commit');
  }catch(e){await db.query('rollback');throw e;}finally{db.release();}
  await audit(user.tenant,`CashBarber ${change.kind} ${change.external_id}: ${result.state}, operador ${user.name}.`);return result;
 }
 async function route(user,c,action,input){
  const link=await one(pool,'select client_id from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]);if(!link)throw cashError('Vincule o cliente antes de gerenciar agendamentos.');
  if(action==='appointment')return client.call(user.tenant,'appointment',{id:externalId(input.id),clientId:link.client_id});
  if(action==='change-preview'){
   const external=externalId(input.id);
   if(await one(pool,"select id from cashbarber_changes where tenant=$1 and external_id=$2 and state in ('pending','uncertain')",[user.tenant,external]))throw cashError('Existe uma alteração sem confirmação. Use Verificar resultado.',409);
   if(await one(pool,"select id from cashbarber_bookings where tenant=$1 and conversation=$2 and state in ('pending','uncertain')",[user.tenant,c.id]))throw cashError('Verifique o agendamento pendente antes de alterar.',409);
   const preview=await client.call(user.tenant,'change-preview',{kind:input.kind,id:external,clientId:link.client_id,professionalId:input.professionalId,services:input.services,date:input.date,start:input.start});
   if(preview.before?.clientId!==link.client_id||preview.before.id!==external||preview.kind!==input.kind)throw cashError('Conferência do agendamento não reconhecida.',502);
   const stamp=Date.now(),id=randomUUID();await pool.query("insert into cashbarber_changes(id,tenant,conversation,actor,external_id,client_id,kind,state,preview,created,updated,expires) values($1,$2,$3,$4,$5,$6,$7,'preview',$8,$9,$9,$10)",[id,user.tenant,c.id,user.id,external,link.client_id,input.kind,JSON.stringify(preview),stamp,stamp+300000]);return {...preview,id};
  }
  if(!/^[a-f0-9-]{36}$/i.test(input.id||''))throw cashError('Conferência inválida.');
  let change=await one(pool,'select * from cashbarber_changes where id=$1 and tenant=$2 and conversation=$3',[input.id,user.tenant,c.id]);if(!change)throw cashError('Tentativa não encontrada.',404);
  if(action==='change-reconcile'){
   if(!['pending','uncertain'].includes(change.state))return change.result||{state:change.state};
   let result;try{result=await client.call(user.tenant,'change-reconcile',{operation:change.id,kind:change.kind,externalId:change.external_id,startedAt:Number(change.updated)});}catch(e){throw cashError(e.message||'Não foi possível verificar. Tente consultar novamente.',409);}
   return finish(user,change,result);
  }
  if(action!=='change-commit')throw cashError('Operação não encontrada.',404);
  if(input.confirm!==true)throw cashError('Confirme a alteração ou exclusão do agendamento.');
  const db=await pool.connect();try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['cashbarber-change:'+user.tenant+':'+change.external_id]);
   const currentConversation=await one(db,'select * from conversations where id=$1 and tenant=$2 for update',[c.id,user.tenant]);
   if(!currentConversation||!canReplyAttendance(user,currentConversation))throw cashError('O atendimento foi encerrado ou transferido. Atualize a conversa.',409);
   const currentLink=await one(db,'select client_id from cashbarber_links where tenant=$1 and conversation=$2 for share',[user.tenant,c.id]);
   change=await one(db,'select * from cashbarber_changes where id=$1 and tenant=$2 for update',[change.id,user.tenant]);
   if(change.state!=='preview'){await db.query('commit');return change.result||{state:'uncertain',message:'Operação já iniciada. Use Verificar resultado.'};}
   if(change.actor!==user.id||change.expires<Date.now()||currentLink?.client_id!==change.client_id||change.preview.available!==true)throw cashError('A conferência expirou, o cliente mudou ou o horário está indisponível. Consulte novamente.',409);
   if(await one(db,"select id from cashbarber_changes where tenant=$1 and external_id=$2 and state in ('pending','uncertain')",[user.tenant,change.external_id]))throw cashError('Há outra alteração pendente para este agendamento.',409);
   await db.query("update cashbarber_changes set state='pending',updated=$1 where id=$2",[Date.now(),change.id]);await db.query('commit');
  }catch(e){await db.query('rollback');throw e;}finally{db.release();}
  let result;try{result=await client.call(user.tenant,'change-commit',{operation:change.id,preview:change.preview});}catch{result={state:'uncertain',kind:change.kind,externalId:change.external_id,message:'Resultado não confirmado. Use Verificar resultado; não repita a alteração.'};}
  return finish(user,change,result);
 }
 return {route};
}
