import {randomUUID} from 'node:crypto';
import {createCashbarberClient} from './cashbarber-client.mjs';
import {cashError} from './cashbarber-domain.mjs';
import {dayAt,scheduledAt,subscriptionTargets,subscriptionText} from './daily-actions-domain.mjs';
import {normalizeContactPhone} from '../public/contact-domain.mjs';
import {canonicalPhone} from './whatsapp-phone.mjs';
import {findWhatsAppConversation,whatsappCustomerPhone} from './whatsapp-conversation.mjs';

const requestedRetry='Nova tentativa solicitada após conferência no CashBarber.';

export function createDailyActions({pool,send,usesQr,client=createCashbarberClient().forService(),now=Date.now,renewal=async()=>null}){
 const q=async(sql,args=[])=>(await pool.query(sql,args)).rows;
 const features=['subscriptions','comandas'];
 async function settings(user,input={}){
  if(user.role!=='admin')throw cashError('Apenas administradores configuram as rotinas.',403);
  if(input.action==='options')return client.call(user.tenant,'daily-comanda-options');
  if(input.action==='run-comandas'){
   if(input.confirm!==true)throw cashError('Confirme o fechamento e o registro dos saldos pendentes.');
   await process(user.tenant);
  }else if(input.save){
   if(!features.includes(input.feature)||typeof input.enabled!=='boolean')throw cashError('Configuração inválida.');
   let account=null,cashbox='',method='';
   if(input.feature==='subscriptions'){
    account=(await q("select * from accounts where tenant=$1 and id=$2 and channel='whatsapp' and enabled and mode='live' and deleted_at is null",[user.tenant,input.account||null]))[0];
    if(input.enabled&&(!account||!usesQr(account)))throw cashError('Selecione um WhatsApp ativo por QR.');
   }else{
    cashbox=String(input.cashbox||'');method=String(input.payment_method||'');
    if(input.enabled){
     if(input.acknowledge!==true)throw cashError('Confirme que o fechamento registra pagamento, inclusive dos saldos pendentes.');
     const options=await client.call(user.tenant,'daily-comanda-options');
     if(!options.boxes.some(x=>x.id===cashbox)||!options.methods.some(x=>x.id===method))throw cashError('Selecione caixa e forma de pagamento disponíveis na filial.');
    }
   }
   await q(`insert into daily_action_settings(tenant,feature,enabled,account,cashbox,payment_method,updated,enabled_at)
    values($1,$2,$3,$4,$5,$6,$7,case when $3 then $7::bigint else null end)
    on conflict(tenant,feature) do update set enabled=excluded.enabled,account=excluded.account,cashbox=excluded.cashbox,payment_method=excluded.payment_method,
    updated=greatest(daily_action_settings.updated+1,excluded.updated),enabled_at=case when excluded.enabled then coalesce(daily_action_settings.enabled_at,excluded.enabled_at) else null end,error=''`,[user.tenant,input.feature,input.enabled,account?.id||null,cashbox,method,now()]);
   if(!input.enabled){
    await q("update daily_action_runs set state='cancelled',updated=$3 where tenant=$1 and feature=$2 and state in ('discovering','executing')",[user.tenant,input.feature,now()]);
    if(input.feature==='subscriptions')await q("update appointment_notifications set state='cancelled',error='Rotina de assinaturas desligada.',updated=$2 where tenant=$1 and kind='subscription' and state='pending'",[user.tenant,now()]);
    else await q("update daily_action_items set state='cancelled',error='Rotina desligada.',updated=$2 where tenant=$1 and state='pending'",[user.tenant,now()]);
   }
  }
  const rows=await q('select feature,enabled,account,cashbox,payment_method,last_run,error from daily_action_settings where tenant=$1',[user.tenant]);
  const runs=await q(`select r.day,r.feature,r.state,r.updated,(select count(*)::int from daily_action_items i where i.run=r.id and i.state='closed') as closed,
   (select count(*)::int from daily_action_items i where i.run=r.id and i.state in ('failed','uncertain')) as attention from daily_action_runs r where tenant=$1 order by updated desc limit 14`,[user.tenant]);
  const items=await q("select external_id,state,error,updated from daily_action_items where tenant=$1 order by updated desc limit 30",[user.tenant]);
  return {settings:features.map(feature=>rows.find(r=>r.feature===feature)||{feature,enabled:false}),runs,items};
 }
 async function current(config){return (await q('select * from daily_action_settings where tenant=$1 and feature=$2 and enabled and updated=$3',[config.tenant,config.feature,config.updated]))[0];}
 async function prepareSubscriptions(config,run){
  if(run.state==='discovering'){
   const items=[];
   for(const target of subscriptionTargets(run.day)){
    const result=await client.call(config.tenant,'daily-subscriptions',{date:target.day});
    for(const item of result.items)items.push({...item,date:target.day,notice:target.notice});
   }
   await q("update daily_action_runs set state='executing',payload=$2,updated=$3 where id=$1 and state='discovering'",[run.id,JSON.stringify({items}),now()]);return;
  }
  const items=run.payload.items||[],errors=run.payload.errors||[];let cursor=run.cursor;
  for(const item of items.slice(cursor,cursor+3)){
   if(!await current(config))return;
   let customer;
   try{customer=await client.call(config.tenant,'daily-subscriber',item);}catch(error){if(error.status!==422)throw error;errors.push('Assinatura '+item.id+': '+error.message);customer={active:false};}
   if(customer.active){
    let phone='';try{phone=normalizeContactPhone(customer.phone);}catch{}
    if(phone){
     const key=`subscription:${canonicalPhone(phone)}:${item.date}:${item.notice}`;
     await q(`insert into appointment_notifications(id,tenant,account,external_id,revision,kind,due,state,body,updated,client_name,recipient,starts_at,notice,source)
      values($1,$2,$3,$4,$5,'subscription',$6,'pending',$7,$8,$9,$10,$11,$12,$13) on conflict(tenant,external_id,revision,kind) do nothing`,[randomUUID(),config.tenant,config.account,key,run.day,scheduledAt(run.day,'subscriptions'),subscriptionText(item.date),now(),customer.name,phone,Date.parse(item.date+'T12:00:00-03:00'),item.notice,JSON.stringify(item)]);
    }else errors.push('Assinatura '+item.id+' sem telefone válido. Corrija no CashBarber.');
   }
   cursor++;await q('update daily_action_runs set cursor=$2,updated=$3,payload=$4 where id=$1 and state=\'executing\'',[run.id,cursor,now(),JSON.stringify({...run.payload,errors})]);
  }
  // All candidates are resolved before delivery, so duplicates are collapsed.
  if(cursor>=items.length){
   const pending=await q("select * from appointment_notifications where tenant=$1 and kind='subscription' and revision=$2 and state='pending' order by due,id limit 3",[config.tenant,run.day]);
   for(const job of pending){if(!await current(config))return;await deliver(config,job);}
   if(!(await q("select id from appointment_notifications where tenant=$1 and kind='subscription' and revision=$2 and state='pending' limit 1",[config.tenant,run.day])).length)await finish(config,{...run,payload:{...run.payload,errors}});
  }
 }
 async function deliver(config,job){
  const customer=await client.call(config.tenant,'daily-subscriber',job.source);
  let phone='';try{phone=normalizeContactPhone(customer.phone);}catch{}
  if(!customer.active||canonicalPhone(phone)!==canonicalPhone(job.recipient)){
   await q("update appointment_notifications set state='cancelled',error='Assinatura ou telefone alterado antes do envio.',updated=$2 where id=$1 and state='pending'",[job.id,now()]);return;
  }
  const sender=(await q("select * from accounts where id=$1 and tenant=$2 and enabled and mode='live' and deleted_at is null",[config.account,config.tenant]))[0];
  if(!sender||!usesQr(sender))throw cashError('WhatsApp de envio indisponível.',409);
  let body=subscriptionText(job.source.date);
  try{
   const checkout=await renewal(config.tenant,job.source,customer);
   if(checkout?.paid){
    await q("update appointment_notifications set state='cancelled',error='Renovação já paga no Mercado Pago.',updated=$2 where id=$1 and state='pending'",[job.id,now()]);return;
   }
   if(checkout)body=subscriptionText(job.source.date,checkout);
  }catch(error){
   await q("update appointment_notifications set state='failed',error=$3,updated=$2 where id=$1 and state='pending'",[job.id,now(),error.status?error.message:'Falha ao preparar o link do Mercado Pago. Confira a configuração.']);return;
  }
  const claim=await q(`update appointment_notifications n set state='sending',updated=$2,account=$3,body=$5 where id=$1 and state='pending'
   and exists(select 1 from daily_action_settings s where s.tenant=n.tenant and s.feature='subscriptions' and s.enabled and s.updated=$4 and s.account=$3) returning id`,[job.id,now(),sender.id,config.updated,body]);
  if(!claim.length)return;
  let message;
  try{
   const conversation=await findWhatsAppConversation(async(sql,args)=>(await q(sql,args))[0],sender,job.recipient)||(await q(`insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,attendance_eligible) values($1,$2,$3,$4,$5,'resolved',$6,0,false) on conflict(account,customer) do update set customer=excluded.customer returning id`,[randomUUID(),config.tenant,sender.id,whatsappCustomerPhone(job.recipient),job.client_name,now()]))[0];
   message=randomUUID();await q("insert into messages(id,conversation,direction,body,created,state,attendance_relevant) values($1,$2,'out',$3,$4,'queued',false)",[message,conversation.id,body,now()]);
   await q('update appointment_notifications set message=$2 where id=$1',[job.id,message]);
   await q('update conversations set updated=greatest(updated,$2) where id=$1',[conversation.id,now()]);
   const external=await send(sender,job.recipient,body,job.id);
   await q("update appointment_notifications set state='sent',external=$2,error='',updated=$3 where id=$1",[job.id,external,now()]);
   await q("update messages set state='sent',external=$2 where id=$1",[message,external]);
  }catch(error){
   const state=error.definite?'failed':'uncertain';
   await q('update appointment_notifications set state=$2,error=$3,updated=$4 where id=$1',[job.id,state,error.definite?'Envio recusado pelo WhatsApp.':'Entrega não confirmada. Confira no WhatsApp; não será repetida automaticamente.',now()]);
   if(message)await q('update messages set state=$2 where id=$1',[message,state]);
  }
 }
 async function finish(config,run){await q("update daily_action_runs set state='complete',updated=$2 where id=$1 and state='executing'",[run.id,now()]);await q('update daily_action_settings set last_run=$3,error=$4 where tenant=$1 and feature=$2',[config.tenant,config.feature,now(),(run.payload.errors||[]).slice(0,10).join(' · ')]);}
 async function prepareComandas(config,run){
  if(run.state==='discovering'){
   const page=await client.call(config.tenant,'daily-comandas',{page:run.cursor});
   if(!await current(config))return;
   // Finish discovery before financial writes: closing can change pagination.
   for(const id of page.ids)await q(`insert into daily_action_items(id,tenant,run,external_id,updated) values($1,$2,$3,$4,$5) on conflict(tenant,external_id) do update set run=excluded.run,state='pending',error='',updated=excluded.updated where daily_action_items.state in ('pending','cancelled')`,[randomUUID(),config.tenant,run.id,id,now()]);
   const state=run.cursor+1>=page.lastPage?'executing':'discovering';
   return (await q('update daily_action_runs set cursor=$2,state=$3,updated=$4 where id=$1 and state=\'discovering\' returning state',[run.id,run.cursor+1,state,now()]))[0]?.state;
  }
  const pending=await q("select * from daily_action_items where run=$1 and state='pending' order by updated,id limit 3",[run.id]);
  for(const item of pending){
   if(!await current(config))return;
   const claimed=await q(`update daily_action_items i set state='sending',updated=$2 where id=$1 and state='pending' and exists(select 1 from daily_action_settings s where s.tenant=i.tenant and s.feature='comandas' and s.enabled and s.updated=$3) returning id`,[item.id,now(),config.updated]);
   if(!claimed.length)continue;
   try{
    const result=await client.call(config.tenant,'daily-close-comanda',{id:item.external_id,cashbox:config.cashbox,payment_method:config.payment_method,retryUnconfirmed:item.error===requestedRetry});
    if(!['closed','skipped','failed','uncertain'].includes(result.state))throw Error('Invalid result');
    await q('update daily_action_items set state=$2,error=$3,updated=$4 where id=$1',[item.id,result.state,result.error||'',now()]);
   }catch(error){
    // Busy is rejected before execution; everything else is conservatively held.
    const busy=error.status===409&&/outra consulta|ocupado/.test(error.message);
    await q('update daily_action_items set state=$2,error=$3,updated=$4 where id=$1',[item.id,busy?'pending':'uncertain',busy?item.error:error.message,now()]);if(busy)return;
   }
  }
  if(!(await q("select id from daily_action_items where run=$1 and state='pending' limit 1",[run.id])).length)await finish(config,run);
 }
 async function process(forceTenant=null){
  if(!client.configured()){
   if(forceTenant)throw cashError('Conexão CashBarber indisponível.',409);
   return {processed:0};
  }
  const tick=now(),day=dayAt(tick);
  const configs=forceTenant
   ?await q("select * from daily_action_settings where enabled and feature='comandas' and tenant=$1 and cashbox<>'' and payment_method<>''",[forceTenant])
   :await q('select * from daily_action_settings where enabled order by last_run nulls first,feature');
  if(forceTenant&&!configs.length)throw cashError('Ative e salve o fechamento com caixa e forma de pagamento antes de executar.',409);
  let processed=0;
  for(const config of configs){
   const start=scheduledAt(day,config.feature);
   const outsideStart=tick<start||tick>=start+60000||config.enabled_at>start;
   if(!forceTenant&&outsideStart){
    // Outside the scheduled minute, only continue a run already started that day.
    if(!(await q("select id from daily_action_runs where tenant=$1 and feature=$2 and day=$3 and state in ('discovering','executing')",[config.tenant,config.feature,day])).length)continue;
   }
   const lease=randomUUID(),locked=await q('update daily_action_settings set lease=$3,lease_until=$4 where tenant=$1 and feature=$2 and enabled and updated=$5 and lease_until<$6 returning tenant',[config.tenant,config.feature,lease,now()+600000,config.updated,now()]);
   if(!locked.length){
    if(forceTenant)throw cashError('O fechamento está em andamento ou a configuração mudou. Atualize o histórico.',409);
    continue;
   }
   try{
    await q("update daily_action_runs set state='cancelled',updated=$3 where tenant=$1 and feature=$2 and day<>$4 and state in ('discovering','executing')",[config.tenant,config.feature,now(),day]);
    if(config.feature==='subscriptions'){
     await q("update appointment_notifications set state='uncertain',error='Execução interrompida. Confira a entrega no WhatsApp.',updated=$2 where tenant=$1 and kind='subscription' and state='sending' and updated<$3",[config.tenant,now(),now()-600000]);
     await q("update messages set state='uncertain' where state='queued' and id in (select message from appointment_notifications where tenant=$1 and kind='subscription' and state='uncertain')",[config.tenant]);
     await q("update appointment_notifications set state='expired',error='Dia de envio ultrapassado.',updated=$2 where tenant=$1 and kind='subscription' and state='pending' and revision<>$3",[config.tenant,now(),day]);
    }else await q("update daily_action_items set state='uncertain',error='Execução interrompida. Confira no CashBarber; não será repetida.',updated=$2 where tenant=$1 and state='sending' and updated<$3",[config.tenant,now(),now()-600000]);
    await q(`insert into daily_action_runs(id,tenant,feature,day,updated) values($1,$2,$3,$4,$5)
      on conflict(tenant,feature,day) do update set state='discovering',cursor=0,updated=excluded.updated
      where $6::boolean and daily_action_runs.state in ('complete','cancelled')`,[randomUUID(),config.tenant,config.feature,day,now(),!!forceTenant]);
    const run=(await q('select * from daily_action_runs where tenant=$1 and feature=$2 and day=$3',[config.tenant,config.feature,day]))[0];
    if(['complete','cancelled'].includes(run.state))continue;
    if(config.feature==='subscriptions')await prepareSubscriptions(config,run);
    else{
     const state=await prepareComandas(config,run);
     if(forceTenant&&state==='executing')await prepareComandas(config,{...run,state});
    }
    processed++;
   }catch(error){
    const message=error.status?error.message:'Falha na rotina. Confira a configuração e o histórico.';
    await q('update daily_action_settings set error=$3 where tenant=$1 and feature=$2',[config.tenant,config.feature,message]);
    if(forceTenant)throw cashError(message,error.status||502);
   }
   finally{await q('update daily_action_settings set lease=null,lease_until=0 where tenant=$1 and feature=$2 and lease=$3',[config.tenant,config.feature,lease]);}
  }
  return {processed};
 }
 return {settings,process};
}
