import {randomUUID,createHash} from 'node:crypto';
import {sameWhatsAppPhone} from './whatsapp-phone.mjs';
import {createCashbarberClient} from './cashbarber-client.mjs';
import {cashError} from './cashbarber-domain.mjs';
import {notificationPlan,notificationText,notificationGrace,notificationDay,localDate,allowedMessageTime} from './appointment-notifications-domain.mjs';
import {createCashbarberContacts} from './cashbarber-contacts.mjs';
import {findWhatsAppConversation,whatsappCustomerPhone} from './whatsapp-conversation.mjs';

const revision=b=>createHash('sha256').update(JSON.stringify([b.startsAt,b.clientId,b.phone,b.services])).digest('hex');
const outsideWindow='Mensagem preparada antes da janela de envio.';
export function createAppointmentNotifications({pool,send,usesQr,client=createCashbarberClient().forService(),now=Date.now}){
  const query=async(sql,args=[])=>(await pool.query(sql,args)).rows;
  const directory=createCashbarberContacts({pool,client});
  // Fetch all siblings before preparing or sending the customer's daily message.
  async function dailyBooking(tenant,booking,feed,cache=new Map()){
    if(!booking.active||!booking.phone||!Number.isSafeInteger(booking.startsAt))return booking;
    const date=localDate(booking.startsAt);
    feed ||= await client.call(tenant,'notification-agenda',{date,grouping:true});
    const ids=feed.groups?feed.groups.filter(b=>!b.clientId||(b.clientId===String(booking.clientId)&&b.date===date)).map(b=>b.id):feed.ids;
    const members=[];
    for(const id of new Set([booking.id,...ids])){
      let row=cache.get(id);
      if(!row){row=id===booking.id?booking:await client.call(tenant,'notification-appointment',{id});cache.set(id,row);}
      if(row.active&&Number.isSafeInteger(row.startsAt)&&localDate(row.startsAt)===date&&sameWhatsAppPhone(row.phone,booking.phone))members.push(row);
    }
    members.sort((a,b)=>a.startsAt-b.startsAt||String(a.id).localeCompare(String(b.id)));
    const eligible=[];
    for(const row of members){
      const seen=(await query('select * from appointment_notification_observations where tenant=$1 and external_id=$2',[tenant,row.id]))[0];
      const bookedAt=seen&&seen.starts_at!==row.startsAt?now():seen?.booked_at??row.createdAt;
      await query(`insert into appointment_notification_observations(tenant,external_id,starts_at,booked_at) values($1,$2,$3,$4)
        on conflict(tenant,external_id) do update set starts_at=excluded.starts_at,booked_at=excluded.booked_at`,[tenant,row.id,row.startsAt,bookedAt??null]);
      if(notificationPlan({...row,bookedAt},now()).length)eligible.push({...row,bookedAt});
    }
    if(!eligible.length)return booking;
    return {...eligible[0],appointments:members.filter(b=>b.startsAt>now())};
  }
  // Serialize manual/automatic claims and honor legacy delivery history too.
  async function claimDaily(job,sql,args){
    const connection=await pool.connect();
    try{
      await connection.query('begin');
      await connection.query('select tenant from appointment_notification_settings where tenant=$1 for update',[job.tenant]);
      const start=Date.parse(localDate(job.starts_at)+'T00:00:00-03:00');
      const siblings=(await connection.query('select id,state,recipient from appointment_notifications where tenant=$1 and kind=$2 and starts_at >= $3 and starts_at < $4',[job.tenant,job.kind,start,start+86400000])).rows.filter(b=>sameWhatsAppPhone(b.recipient,job.recipient));
      if(siblings.some(b=>b.id!==job.id&&['sending','sent','uncertain','failed'].includes(b.state))){
        await connection.query("update appointment_notifications set state='cancelled',error='Mensagem deste cliente e dia já processada.',updated=$2 where id=$1 and state in ('pending','expired')",[job.id,now()]);
        await connection.query('commit');return null;
      }
      const claimed=(await connection.query(sql,args)).rows[0];
      if(claimed)for(const sibling of siblings)if(sibling.id!==job.id&&['pending','expired'].includes(sibling.state))await connection.query("update appointment_notifications set state='cancelled',error='Agendamentos reunidos em uma única mensagem para este cliente e dia.',updated=$2 where id=$1 and state in ('pending','expired')",[sibling.id,now()]);
      await connection.query('commit');return claimed;
    }catch(error){await connection.query('rollback');throw error;}finally{connection.release();}
  }
  async function manual(user,input,job){
    if(!['admin','receptionist'].includes(user.role)||job.tenant!==user.tenant||(user.role!=='admin'&&!(user.accounts||[]).includes(job.account)))throw cashError('Mensagem indisponível.',403);
    if(!['pending','expired'].includes(job.state))throw cashError('Esta mensagem não está disponível para envio manual.',409);
    const detail=await client.call(user.tenant,'notification-appointment',{id:job.external_id});
    if(!detail.active||!detail.phone||!Number.isSafeInteger(detail.startsAt)||detail.startsAt<=now()||detail.startsAt!==job.starts_at)throw cashError('A reserva foi alterada, cancelada ou já começou. Aguarde a atualização da agenda.',409);
    if(localDate(detail.startsAt)!==localDate(now()+(job.kind==='confirmation'?notificationDay:0)))throw cashError('A mensagem está fora do dia de envio.',409);
    const booking=await dailyBooking(user.tenant,detail);
    const body=notificationText(booking,job.kind,job.due),fingerprint=createHash('sha256').update(JSON.stringify([job.id,body,booking.phone,booking.startsAt,booking.appointments])).digest('hex');
    const preview={body,fingerprint,recipient:booking.phone,client_name:booking.clientName,professional_name:booking.professionalName,starts_at:booking.startsAt};
    if(input.action==='preview-send')return preview;
    if(input.action!=='send'||input.confirm!==true||input.fingerprint!==fingerprint)throw cashError('Revise a prévia atualizada antes de enviar.',409);
    if(!allowedMessageTime(now()))throw cashError('O envio é permitido somente a partir das 8h, no horário de Brasília.',409);
    const sender=(await query("select * from accounts where id=$1 and tenant=$2 and enabled and mode='live' and deleted_at is null",[job.account,user.tenant]))[0];
    if(!sender||!usesQr(sender))throw cashError('WhatsApp de envio indisponível.',409);
    await directory.saveCustomers({tenant:user.tenant,id:user.id,name:user.name},sender.id,[{id:booking.clientId,name:booking.clientName,phone:booking.phone,email:booking.email||'',active:true}]);
    const claimed=await claimDaily({...job,recipient:booking.phone},"update appointment_notifications set state='sending',body=$3,client_name=$4,professional_name=$5,recipient=$6,updated=$7 where id=$1 and tenant=$2 and state in ('pending','expired') returning id",[job.id,user.tenant,body,booking.clientName||'',booking.professionalName||'',booking.phone,now()]);
    if(!claimed)throw cashError('A situação da mensagem mudou. Atualize a lista.',409);
    let message;
    try{
      const conversation=await findWhatsAppConversation(async(sql,args)=>(await query(sql,args))[0],sender,booking.phone)||(await query(`insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,attendance_eligible) values($1,$2,$3,$4,$5,'resolved',$6,0,false) on conflict(account,customer) do update set customer=excluded.customer returning id`,[randomUUID(),user.tenant,sender.id,whatsappCustomerPhone(booking.phone),booking.clientName||booking.phone,now()]))[0];
      message=randomUUID();await query("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name,attendance_relevant) values($1,$2,'out',$3,$4,'queued',$5,$6,false)",[message,conversation.id,body,now(),user.id,user.name]);
      await query('update appointment_notifications set message=$2 where id=$1',[job.id,message]);
      await query('update conversations set updated=greatest(updated,$2) where id=$1',[conversation.id,now()]);
      const external=await send(sender,booking.phone,body,job.id);
      await query("update appointment_notifications set state='sent',external=$2,error='',updated=$3 where id=$1",[job.id,external,now()]);
      await query("update messages set state='sent',external=$2 where id=$1",[message,external]);return {state:'sent'};
    }catch(error){const state=error.definite?'failed':'uncertain';await query('update appointment_notifications set state=$2,error=$3,updated=$4 where id=$1',[job.id,state,error.definite?'Envio recusado pelo WhatsApp.':'Entrega não confirmada. Confira o WhatsApp antes de enviar novamente.',now()]);if(message)await query('update messages set state=$2 where id=$1',[message,state]);return {state};}
    finally{if(message)await query('update conversations set updated=greatest(updated,$2) where id=(select conversation from messages where id=$1)',[message,now()]);}
  }
  async function connection(user,input){
    if(user.role!=='admin')throw cashError('Apenas administradores conectam o serviço de mensagens.',403);
    const action=input.action;
    if(!['login','status','disconnect'].includes(action))throw cashError('Ação de conexão inválida.');
    if(!client.configured())return {configured:false,connected:false};
    if(action==='login'&&(typeof input.email!=='string'||input.email.length>200||typeof input.password!=='string'||!input.password||input.password.length>200))throw cashError('Informe o e-mail e a senha da conta CashBarber da automação.');
    return {configured:true,...await client.call(user.tenant,action,action==='login'?{email:input.email,password:input.password,branchId:input.branchId||undefined,remember:true}:{refresh:true})};
  }
  async function settings(user,input={}){
    if(user.role!=='admin')throw cashError('Apenas administradores configuram as mensagens da agenda.',403);
    if(input.save===true){
      if(typeof input.enabled!=='boolean')throw cashError('Estado de envio inválido.');
      if(input.delivery_mode!==undefined&&!['manual','automatic'].includes(input.delivery_mode))throw cashError('Modo de envio inválido.');
      if(!input.enabled&&input.delivery_mode==='automatic')throw cashError('Ative a consulta da agenda para ligar o envio automático.');
      const account=(await query("select * from accounts where id=$1 and tenant=$2 and channel='whatsapp' and mode='live' and enabled and deleted_at is null",[input.account||null,user.tenant]))[0];
      if(input.enabled&&(!account||!usesQr(account)))throw cashError('Selecione um WhatsApp ativo conectado por QR para as mensagens da agenda.');
      await query(`insert into appointment_notification_settings(tenant,enabled,account,updated,delivery_mode) values($1,$2,$3,$4,coalesce($5,'manual'))
        on conflict(tenant) do update set enabled=excluded.enabled,account=excluded.account,updated=greatest(excluded.updated,appointment_notification_settings.updated+1),delivery_mode=case when excluded.enabled then coalesce($5,appointment_notification_settings.delivery_mode) else 'manual' end,error=''`,[user.tenant,input.enabled,account?.id||null,now(),input.delivery_mode??null]);
    }
    return {settings:(await query('select enabled,account,delivery_mode,last_run,error from appointment_notification_settings where tenant=$1',[user.tenant]))[0]||{enabled:false,account:null,delivery_mode:'manual'},history:await query('select external_id,kind,state,error,due,updated,body from appointment_notifications where tenant=$1 order by updated desc limit 50',[user.tenant])};
  }
  async function processTenant(config){
    const lease=randomUUID();
    const locked=(await query('update appointment_notification_settings set lease=$2,lease_until=$3 where tenant=$1 and enabled and lease_until<$4 returning *',[config.tenant,lease,now()+300000,now()]))[0];
    if(!locked)return;
    const tenant=config.tenant,started=now();
    try{
      await query("update appointment_notifications set state='uncertain',error='Execução interrompida; confira a entrega antes de qualquer envio manual.',updated=$2 where tenant=$1 and kind in ('confirmation','reminder') and state='sending' and updated<$3",[tenant,now(),now()-300000]);
      await query("update messages set state='uncertain' where state='queued' and id in (select message from appointment_notifications where tenant=$1 and state='uncertain')",[tenant]);
      const sender=(await query("select * from accounts where id=$1 and tenant=$2 and channel='whatsapp' and mode='live' and enabled and deleted_at is null",[locked.account,tenant]))[0];
      if(!sender||!usesQr(sender))throw cashError('WhatsApp de envio indisponível. Confira a configuração.',409);
      const date=localDate(started),tomorrow=localDate(started+notificationDay);
      const todayStart=Date.parse(date+'T00:00:00-03:00'),tomorrowStart=todayStart+notificationDay;
      // Retire drafts prepared by the old window. Future drafts can be restored on their send day.
      await query(`update appointment_notifications set state='cancelled',error=$4,updated=$5
        where tenant=$1 and state='pending' and ((kind='reminder' and starts_at >= $2) or (kind='confirmation' and starts_at >= $3))`,
        [tenant,tomorrowStart,tomorrowStart+notificationDay,outsideWindow,started]);
      await query(`update appointment_notifications set state='expired',error='Dia de envio ultrapassado.',updated=$4
        where tenant=$1 and state='pending' and ((kind='reminder' and starts_at < $2) or (kind='confirmation' and starts_at < $3))`,
        [tenant,todayStart,tomorrowStart,started]);
      const ids=[],feeds=new Map(),cache=new Map();
      for(const day of [date,tomorrow]){const feed=await client.call(tenant,'notification-agenda',{date:day,grouping:true});feeds.set(day,feed);ids.push(...feed.ids);}
      const unique=[...new Set(ids)].sort();
      // Cycle through the entire agenda instead of starving the last appointments.
      const after=unique.filter(id=>id>locked.cursor),cycle=[...after,...unique.filter(id=>id<=locked.cursor)];
      const due=await query("select distinct external_id from appointment_notifications where tenant=$1 and kind in ('confirmation','reminder') and state='pending' and due<=$2 order by external_id limit 12",[tenant,now()]);
      const batch=[...new Set([...due.map(j=>j.external_id),...cycle.slice(0,12)])];
      let cursor=locked.cursor,missing=0;
      for(const id of batch){
        if(now()-started>45000)break;
        const detail=cache.get(id)||await client.call(tenant,'notification-appointment',{id});cache.set(id,detail);
        const feed=Number.isSafeInteger(detail.startsAt)?feeds.get(localDate(detail.startsAt)):undefined;
        const booking=feed?await dailyBooking(tenant,detail,feed,cache):detail;
        if(booking.id!==id){
          await query("update appointment_notifications set state='cancelled',error='Agendamentos reunidos em uma única mensagem para este cliente e dia.',updated=$3 where tenant=$1 and external_id=$2 and state in ('pending','expired')",[tenant,id,now()]);
          if(cycle.slice(0,12).includes(id))cursor=id;
          continue;
        }
        if(booking.active&&booking.phone&&booking.clientName)await directory.saveCustomers({tenant,id:null,name:'Automação da agenda CashBarber'},sender.id,[{id:booking.clientId,name:booking.clientName,phone:booking.phone,email:booking.email||'',active:true}]);
        const existing=(await query('select * from appointment_notification_observations where tenant=$1 and external_id=$2',[tenant,id]))[0];
        const bookedAt=existing&&existing.starts_at!==booking.startsAt?now():existing?.booked_at??booking.createdAt;
        const current={...booking,bookedAt};
        const previous=(await query("select revision from appointment_notifications where tenant=$1 and external_id=$2 and starts_at=$3 and (recipient=$4 or recipient='') order by updated desc limit 1",[tenant,id,booking.startsAt??null,booking.phone||'']))[0];
        const version=previous?.revision||revision(current);
        await query("update appointment_notifications set client_name=$3,professional_name=$4,recipient=$5,starts_at=$6 where tenant=$1 and external_id=$2 and revision=$7 and (state='pending' or professional_name='')",[tenant,id,booking.clientName||'',booking.professionalName||'',booking.phone||'',booking.startsAt??null,version]);
        if(booking.active&&(!Number.isSafeInteger(booking.createdAt)||!Number.isSafeInteger(booking.startsAt)))missing++;
        await query(`insert into appointment_notification_observations(tenant,external_id,starts_at,booked_at) values($1,$2,$3,$4)
          on conflict(tenant,external_id) do update set starts_at=excluded.starts_at,booked_at=excluded.booked_at`,[tenant,id,booking.startsAt??null,bookedAt??null]);
        await query("update appointment_notifications set state='cancelled',error='Reserva cancelada, alterada ou indisponível.',updated=$3 where tenant=$1 and external_id=$2 and state='pending' and (revision<>$4 or $5=false)",[tenant,id,now(),version,!!booking.active]);
        const plans=notificationPlan(current,now());
        if(!plans.length)await query("update appointment_notifications set state=$4,error=$5,updated=$3 where tenant=$1 and external_id=$2 and state='pending'",[tenant,id,now(),booking.active&&booking.startsAt<=now()?'expired':'cancelled',booking.active&&booking.startsAt<=now()?'Horário do atendimento ultrapassado.':'Reserva não elegível para mensagens ativas.']);
        for(const plan of plans){
          const state=plan.due+notificationGrace<now()?'expired':'pending';
          // A sibling can become the representative after the first booking is
          // cancelled. Only revive drafts cancelled by grouping, never by staff.
          await query("update appointment_notifications set state=$5,error='',body=$6,due=$7,updated=$8 where tenant=$1 and external_id=$2 and revision=$3 and kind=$4 and state='cancelled' and cancelled_by is null and error in ('Agendamentos reunidos em uma única mensagem para este cliente e dia.',$9)",[tenant,id,version,plan.kind,state,notificationText(current,plan.kind,plan.due),plan.due,now(),outsideWindow]);
          await query(`insert into appointment_notifications(id,tenant,account,external_id,revision,kind,due,state,body,updated,client_name,professional_name,recipient,starts_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(tenant,external_id,revision,kind) do update set body=case when appointment_notifications.state='pending' then excluded.body else appointment_notifications.body end,due=case when appointment_notifications.state='pending' then excluded.due else appointment_notifications.due end`,[randomUUID(),tenant,sender.id,id,version,plan.kind,plan.due,state,notificationText(current,plan.kind,plan.due),now(),booking.clientName||'',booking.professionalName||'',booking.phone||'',booking.startsAt]);
        }
        const jobs=await query("select * from appointment_notifications where tenant=$1 and external_id=$2 and revision=$3 and state='pending' and due<=$4 order by due",[tenant,id,version,now()]);
        for(const job of jobs){
          if(locked.delivery_mode!=='automatic'||!allowedMessageTime(now())||!plans.some(plan=>plan.kind===job.kind))continue;
          if(job.due+notificationGrace<now()){await query("update appointment_notifications set state='expired',error='Horário de envio ultrapassado.',updated=$2 where id=$1",[job.id,now()]);continue;}
          // The detail above is fresh. Claim durably before any network delivery.
          const claim=await claimDaily(job,`update appointment_notifications n set state='sending',updated=$2,account=$5 where n.id=$1 and n.state='pending'
            and exists(select 1 from appointment_notification_settings s join accounts a on a.id=s.account and a.tenant=s.tenant
              where s.tenant=n.tenant and s.enabled and s.delivery_mode='automatic' and s.lease=$3 and s.updated=$4 and a.id=$5 and a.enabled and a.deleted_at is null and a.mode='live') returning n.*`,[job.id,now(),lease,locked.updated,sender.id]);
          if(!claim)continue;
          if(!booking.phone){await query("update appointment_notifications set state='failed',error='Cliente sem telefone válido.',updated=$2 where id=$1",[job.id,now()]);continue;}
          let message;
          try{
            const cid=randomUUID();
            const conversation=await findWhatsAppConversation(async(sql,args)=>(await query(sql,args))[0],sender,booking.phone)||(await query(`insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,attendance_eligible)
              values($1,$2,$3,$4,$5,'resolved',$6,0,false) on conflict(account,customer) do update set customer=excluded.customer returning id`,[cid,tenant,sender.id,whatsappCustomerPhone(booking.phone),booking.clientName||booking.phone,now()]))[0];
            message=randomUUID();await query("insert into messages(id,conversation,direction,body,created,state,attendance_relevant) values($1,$2,'out',$3,$4,'queued',false)",[message,conversation.id,job.body,now()]);
            await query('update appointment_notifications set message=$2 where id=$1',[job.id,message]);
            await query('update conversations set updated=greatest(updated,$2) where id=$1',[conversation.id,now()]);
            const external=await send(sender,booking.phone,job.body,job.id);
            await query("update appointment_notifications set state='sent',external=$2,error='',updated=$3 where id=$1",[job.id,external,now()]);
            await query("update messages set state='sent',external=$2 where id=$1",[message,external]);
          }catch(error){
            const state=error.definite?'failed':'uncertain';
            await query('update appointment_notifications set state=$2,error=$3,updated=$4 where id=$1',[job.id,state,error.definite?'Envio recusado pelo WhatsApp.':'Entrega não confirmada. Confira o WhatsApp antes de qualquer envio manual.',now()]);
            if(message)await query('update messages set state=$2 where id=$1',[message,state]);
          }finally{
            if(message)await query('update conversations set updated=greatest(updated,$2) where id=(select conversation from messages where id=$1)',[message,now()]);
          }
        }
        if(cycle.slice(0,12).includes(id))cursor=id;
      }
      await query("update appointment_notifications set state='expired',error='Horário de envio ultrapassado.',updated=$2 where tenant=$1 and kind in ('confirmation','reminder') and state='pending' and due<$3",[tenant,now(),now()-notificationGrace]);
      await query('update appointment_notification_settings set cursor=$2,last_run=$3,error=$5 where tenant=$1 and lease=$4',[tenant,cursor,now(),lease,missing?`${missing} reserva(s) sem data de criação ou horário verificável no CashBarber; envio suspenso para esses registros.`:'']);
    }catch(error){await query('update appointment_notification_settings set last_run=$2,error=$3 where tenant=$1 and lease=$4',[tenant,now(),error.status?error.message:'Falha ao consultar a agenda. Nenhum envio sem conferência.',lease]);}
    finally{await query('update appointment_notification_settings set lease=null,lease_until=0 where tenant=$1 and lease=$2',[tenant,lease]);}
  }
  async function process(){
    if(!client.configured())return {processed:0};
    const configs=await query('select * from appointment_notification_settings where enabled order by last_run nulls first limit 1');
    for(const config of configs)await processTenant(config);
    return {processed:configs.length};
  }
  return {settings,process,connection,manual};
}
