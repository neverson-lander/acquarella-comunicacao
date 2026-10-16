import {randomUUID,timingSafeEqual} from 'node:crypto';
import {sameWhatsAppPhone} from './whatsapp-phone.mjs';

const invalid=message=>Object.assign(Error(message),{status:400});
export function authorizedAlertJob(header,secret){
  if(!secret)return false;
  const expected=Buffer.from(`Bearer ${secret}`),actual=Buffer.from(header||'');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export function normalizeAlertPhones(values){
  if(!Array.isArray(values)||values.length>20)throw invalid('Cadastre até 20 telefones de alerta por canal.');
  const phones=[];
  for(const value of values){
    if(typeof value!=='string'||!/^\+?[\d\s().-]+$/.test(value.trim())||value.length>32)throw invalid('Telefone de alerta inválido. Use código do país e DDD.');
    const phone=value.replace(/\D/g,'');
    if(!/^[1-9]\d{9,14}$/.test(phone))throw invalid('Telefone de alerta inválido. Use código do país e DDD.');
    if(!phones.some(existing=>sameWhatsAppPhone(existing,phone)))phones.push(phone);
  }
  return phones;
}
export function alertSettings(input,old){
  const enabled=input.alertsEnabled??old?.alerts_enabled??false;
  if(typeof enabled!=='boolean')throw invalid('Estado dos alertas inválido.');
  const minutes=(value,fallback)=>{
    const result=value===undefined?fallback:Number(value);
    if((typeof value!=='number'&&typeof value!=='string'&&value!==undefined)||value===''||!Number.isInteger(result)||result<1||result>1440)throw invalid('Os intervalos de alerta devem ser de 1 a 1440 minutos.');
    return result;
  };
  const phones=normalizeAlertPhones(input.alertPhones===undefined?(old?.alerts_phones??[]):input.alertPhones);
  if(enabled&&!phones.length)throw invalid('Adicione pelo menos um telefone para ativar os alertas.');
  return {enabled,queue:minutes(input.queueAlertMinutes,old?.queue_alert_minutes??15),assigned:minutes(input.assignedAlertMinutes,old?.assigned_alert_minutes??15),phones};
}
const clean=value=>String(value||'').replace(/[\r\n\t]+/g,' ').slice(0,100);
export function alertText(account,queue,assigned,time){
  const lines=[`⚠ Clientes aguardando resposta — ${clean(account.name)}`];
  for(const [label,list] of [['Fila de atendimento',queue],['Atendimentos atribuídos',assigned]]){
    if(!list.length)continue;
    lines.push('',`${label}: ${list.length} cliente(s)`);
    for(const c of list.slice(0,10))lines.push(`• ${clean(c.name)} — ${Math.max(1,Math.floor((time-Number(c.waiting_since))/60000))} min${c.assigned_to?` — Atendente: ${clean(c.assignee_name||'Responsável não identificado')}`:''}`);
    if(list.length>10)lines.push(`… e mais ${list.length-10} cliente(s).`);
  }
  lines.push('','Abra a central para assumir ou responder aos atendimentos.');
  return lines.join('\n').slice(0,4000);
}

export function createWaitingAlerts({pool,send,now=Date.now,requiresWindow=()=>true}){
  async function waiting(client,a,time,queueEnabled=true,assignedEnabled=true){
    let excluded=[];
    if(a.channel==='whatsapp'){
      const tenant=(await client.query('select phone from tenants where id=$1',[a.tenant])).rows[0];
      const sources=(await client.query("select alerts_phones from accounts where tenant=$1 and (bridge=$2 or (id=$2 and bridge is null))",[a.tenant,a.id])).rows;
      excluded=[tenant.phone,...sources.flatMap(source=>source.alerts_phones)];
    }
    const pending=(await client.query(`select c.id,c.name,c.customer,c.assigned_to,u.name as assignee_name,p.waiting_since
      from conversations c left join users u on u.id=c.assigned_to and u.tenant=c.tenant
      cross join lateral (select min(m.created) as waiting_since from messages m
        where m.conversation=c.id and m.direction='in' and m.kind<>'reaction' and m.created<=$2
        and m.created>=coalesce((select max(r.created) from messages r where r.conversation=c.id and r.direction='out' and r.state='sent'),0)) p
      where c.account=$1 and c.tenant=$3 and c.status='open' and c.customer not like 'demo-%' and p.waiting_since is not null
      order by p.waiting_since,c.id`,[a.id,time,a.tenant])).rows.filter(c=>!excluded.some(phone=>sameWhatsAppPhone(c.customer,phone)));
    return {
      queue:queueEnabled?pending.filter(c=>!c.assigned_to&&time-Number(c.waiting_since)>=a.queue_alert_minutes*60000):[],
      assigned:assignedEnabled?pending.filter(c=>c.assigned_to&&time-Number(c.waiting_since)>=a.assigned_alert_minutes*60000):[]
    };
  }
  async function enqueue(aid){
    const client=await pool.connect();
    try{
      await client.query('begin');
      const a=(await client.query('select * from accounts where id=$1 for update skip locked',[aid])).rows[0];
      if(!a?.alerts_enabled||a.enabled===false||a.mode!=='live'||!a.alerts_phones.length){await client.query('commit');return;}
      if((await client.query("select id from jobs where alert_source=$1 and kind='waiting_alert' and state in ('pending','sending') limit 1",[aid])).rows.length){await client.query('commit');return;}
      const time=now(),queueDue=a.queue_alert_at==null||time-Number(a.queue_alert_at)>=a.queue_alert_minutes*60000;
      const assignedDue=a.assigned_alert_at==null||time-Number(a.assigned_alert_at)>=a.assigned_alert_minutes*60000;
      const {queue,assigned}=await waiting(client,a,time,queueDue,assignedDue);
      if(!queue.length&&!assigned.length){await client.query('commit');return;}
      const body=alertText(a,queue,assigned,time),sender=a.bridge||a.id;
      for(const recipient of normalizeAlertPhones(a.alerts_phones))await client.query(`insert into jobs(id,tenant,account,conversation,kind,recipient,body,state,error,created,alert_source,alert_queue,alert_assigned)
        values($1,$2,$3,$4,'waiting_alert',$5,$6,'pending','',$7,$8,$9,$10)`,[randomUUID(),a.tenant,sender,(queue[0]||assigned[0]).id,recipient,body,time,a.id,!!queue.length,!!assigned.length]);
      await client.query('update accounts set queue_alert_at=case when $2 then $4 else queue_alert_at end,assigned_alert_at=case when $3 then $4 else assigned_alert_at end where id=$1',[a.id,!!queue.length,!!assigned.length,time]);
      await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async function claim(candidate){
    const client=await pool.connect();
    try{
      await client.query('begin');
      const a=(await client.query('select * from accounts where id=$1 for update skip locked',[candidate.alert_source])).rows[0];
      if(!a){await client.query('commit');return null;}
      const job=(await client.query("select * from jobs where id=$1 and state='pending' for update skip locked",[candidate.id])).rows[0];
      if(!job){await client.query('commit');return null;}
      const senderId=a.bridge||a.id,time=now();
      const cancelled=!a.alerts_enabled||a.enabled===false||a.mode!=='live'||job.tenant!==a.tenant||senderId!==job.account||!a.alerts_phones.includes(job.recipient);
      const pending=cancelled?{queue:[],assigned:[]}:await waiting(client,a,time,job.alert_queue,job.alert_assigned);
      if(cancelled||(!pending.queue.length&&!pending.assigned.length)){
        await client.query("update jobs set state='cancelled',error='Alerta cancelado: configuração alterada ou clientes já atendidos.' where id=$1",[job.id]);
        await client.query('commit');return null;
      }
      const sender=(await client.query("select * from accounts where id=$1 and tenant=$2 and channel='whatsapp' and mode='live' and enabled",[senderId,a.tenant])).rows[0];
      const windows=sender?(await client.query('select phone,seen from bridge_windows where account=$1',[sender.id])).rows:[];
      const windowOpen=windows.some(w=>sameWhatsAppPhone(w.phone,job.recipient)&&time-Number(w.seen)<86400000);
      const error=!sender?'Configure uma conta WhatsApp real para os alertas.':(requiresWindow(sender)&&!windowOpen)?`O destinatário +${job.recipient} precisa enviar uma mensagem ao número da API para abrir sua janela de 24 horas.`:null;
      job.body=alertText(a,pending.queue,pending.assigned,time);
      await client.query('update jobs set state=$2,error=$3,body=$4,alert_started_at=$5 where id=$1',[job.id,error?'failed':'sending',error||'',job.body,time]);
      if(error)await client.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),a.tenant,`Alerta de ${clean(a.name)}: ${error}`,time]);
      await client.query('commit');return {job,sender,error};
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async function deliver(delivery){
    if(!delivery)return {attempted:0,sent:0,failed:0};
    if(delivery.error)return {attempted:1,sent:0,failed:1};
    try{
      const external=await send(delivery.sender,delivery.job.recipient,delivery.job.body,delivery.job.id);
      await pool.query("update jobs set state='sent',external=$2 where id=$1",[delivery.job.id,external]);
      return {attempted:1,sent:1,failed:0};
    }catch(error){
      await pool.query('update jobs set state=$2,error=$3 where id=$1',[delivery.job.id,error.definite?'failed':'uncertain',String(error.message||error).slice(0,500)]);
      await pool.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),delivery.job.tenant,`Falha no alerta para +${delivery.job.recipient}: ${String(error.message||error).slice(0,180)}`,now()]);
      return {attempted:1,sent:0,failed:1};
    }
  }
  return async function processAlerts(){
    await pool.query("update jobs set state='uncertain',error='Execução interrompida durante o alerta; confira o WhatsApp antes de reenviar.' where kind='waiting_alert' and state='sending' and coalesce(alert_started_at,created)<$1",[now()-120000]);
    const accounts=(await pool.query(`select id from accounts where alerts_enabled and enabled and mode='live' and jsonb_array_length(alerts_phones)>0
      and (queue_alert_at is null or queue_alert_at<=$1-queue_alert_minutes*60000::bigint
        or assigned_alert_at is null or assigned_alert_at<=$1-assigned_alert_minutes*60000::bigint)
      order by least(coalesce(queue_alert_at,0),coalesce(assigned_alert_at,0)),id`,[now()])).rows;
    for(const account of accounts)await enqueue(account.id);
    const jobs=(await pool.query("select id,alert_source from jobs where kind='waiting_alert' and state='pending' order by created,id limit 6")).rows;
    const totals={attempted:0,sent:0,failed:0};
    for(let i=0;i<jobs.length;i+=3){
      const deliveries=[];
      for(const job of jobs.slice(i,i+3))deliveries.push(await claim(job));
      const results=await Promise.all(deliveries.map(deliver));
      for(const result of results)for(const key of Object.keys(totals))totals[key]+=result[key];
    }
    return totals;
  };
}
