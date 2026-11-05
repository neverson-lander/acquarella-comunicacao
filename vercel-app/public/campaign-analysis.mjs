import {realOpportunity,selectedTouch} from './crm-domain.mjs';
import {contactPhoneKey} from './contact-domain.mjs';
import {cashbarberRecords} from './booking-report.mjs';

const day=86400000;
export const directContinuationDays=3;
const closing=h=>h.action==='Atendimento finalizado'||/^Atendimento encerrado em massa|^Interação do Instagram encerrada em massa|^Canal excluído:/.test(h.action||'');
const returning=h=>/Reaberto|Atendimento reaberto|^Nova mensagem após encerramento/.test(h.action||'');
const amount=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const serviceKey=s=>s.external_appointment_id?'external:'+s.external_appointment_id+':'+String(s.service_id||s.name).trim().toLowerCase():s.booking_id?'booking:'+s.booking_id:'reported:'+s.name+':'+(s.date||'')+':'+(s.start||'');
export function attendanceCycles(crm,now=Date.now()){
  const cycles=[],records=cashbarberRecords(crm,now,{includeBulk:true}),claimed=new Set();
  for(const o of crm.opportunities.filter(realOpportunity)){
    const touches=(crm.touches||[]).filter(t=>t.opportunity===o.id&&!t.ignored_for_attribution&&t.created<=now);
    const history=(crm.attendance_history||[]).filter(h=>h.conversation===o.conversation&&h.created<=now).sort((a,b)=>a.created-b.created||String(a.id).localeCompare(String(b.id)));
    const starts=[Number(o.first_contact),...touches.filter(t=>t.referral?.attendance_start).map(t=>Number(t.created))];
    for(const h of history.filter(returning)){
      const previous=history.filter(c=>closing(c)&&c.created<=h.created).at(-1),next=history.find(c=>closing(c)&&c.created>h.created)?.created??Infinity;
      // Opening the conversation and receiving the first message can be several
      // minutes apart. They belong to the same return after that closure.
      const marked=touches.some(t=>t.referral?.attendance_start&&(t.referral.attendance_start===previous?.id||t.created>=(previous?.created??h.created)&&t.created<next));
      if(!marked)starts.push(Number(h.created));
    }
    const boundaries=[...new Set(starts.filter(t=>Number.isFinite(t)&&t<=now))].sort((a,b)=>a-b);
    for(let i=0;i<boundaries.length;i++){
      const start=boundaries[i],until=boundaries[i+1]??Infinity,current=i===boundaries.length-1;
      const inCycle=t=>Number.isFinite(Number(t))&&t>=start&&t<until&&t<=now;
      const localTouches=touches.filter(t=>inCycle(t.created)),touch=selectedTouch({touches:localTouches});
      const closure=history.filter(h=>closing(h)&&inCycle(h.created)).at(-1);
      const ad={...(crm.ads||[]).find(a=>a.ad_id===touch.ad_id),...touch.meta_snapshot};
      const contact=(crm.contacts||[]).find(c=>c.id===o.contact);
      const reference=touch.evidence==='webhook'?Number(touch.created)||start:start;
      const checks=(crm.campaign_checks||[]).filter(c=>c.conversation===o.conversation&&c.ad_id===touch.ad_id&&Number(c.report?.since)===reference&&Number(c.report.checked_at||c.checked_at)<=now);
      const report=checks.at(-1)?.report;
      const services=[],seen=new Set();
      const add=s=>{const key=serviceKey(s);if(seen.has(key)||claimed.has(key)&&s.external_appointment_id)return;seen.add(key);services.push({...s,key,price_cents:amount(s.price_cents)});if(s.external_appointment_id)claimed.add(key);};
      // Durable reservations have priority over copies in closure snapshots/checks.
      const localRecords=records.filter(b=>b.conversation===o.conversation&&(b.closure_id?b.closure_id===closure?.id:inCycle(b.confirmed_at)));
      for(const b of localRecords){const q=b.quote||{};add({name:q.service,service_id:q.serviceId,booking_id:b.id,external_appointment_id:b.receipt?.externalId,date:q.date,start:q.start,professional:q.professionalName,price_cents:q.price,created_at:b.confirmed_at,queried:!!b.queried});}
      for(const s of closure?.scheduling?.services||[]){
        if(s.booking_id&&services.some(v=>v.booking_id===s.booking_id))continue;
        add({...s,service_id:s.service_id||s.id,created_at:closure.created});
      }
      const events=(crm.events||[]).filter(e=>e.opportunity===o.id&&!e.voided&&inCycle(e.occurred));
      const scheduled=services.length>0||closure?.scheduling?.had_scheduling===true||events.some(e=>e.kind==='appointment');
      const status=current&&o.status==='open'?'open':'resolved';
      const outcome=scheduled?'scheduled':status==='open'?'pending':closure?.scheduling?.outcome==='information'?'information':closure?.scheduling?.had_scheduling===false?'not_scheduled':'unknown';
      const conversions=[...services.map(s=>s.created_at),...(closure?.scheduling?.had_scheduling?[closure.created]:[]),...events.filter(e=>e.kind==='appointment').map(e=>e.occurred)].filter(inCycle);
      cycles.push({id:o.id+':'+start,opportunity:o.id,conversation:o.conversation,contact:o.contact,client:contact?.name||o.customer_name||o.customer,phone:contact?.phone||o.customer,email:contact?.email||'',account:o.account,channel:o.channel,owner:o.owner,owner_name:o.owner_name||(crm.team||[]).find(u=>u.id===o.owner)?.name||'Sem responsável',first_contact:start,until,current,closure_id:closure?.id,closed_at:closure?.created||null,status,outcome,source:touch.source,ad_id:touch.ad_id||'',ad_name:ad.ad_name||touch.ad_id||'',campaign:ad.campaign_id||'ad:'+touch.ad_id,campaign_name:ad.campaign_name||ad.campaign_id||'Campanha não identificada',advertised_service:(crm.catalog||[]).find(s=>s.id===ad.service)?.name||ad.offer||'Não informado',identification:touch.evidence==='webhook'?'Automática':touch.evidence==='manual'?'Manual':'Histórico',campaign_contact:reference,services,cashbarber_check:report,events,conversion_at:conversions.length?Math.min(...conversions):null,value_cents:services.reduce((sum,s)=>sum+(s.price_cents??0),0),unknown_value:services.filter(s=>s.price_cents===null).length,sales:events.filter(e=>e.kind==='sale').length,revenue_cents:events.filter(e=>e.kind==='sale').reduce((sum,e)=>sum+(Number(e.amount_cents)||0),0),performed:events.filter(e=>e.kind==='attendance').length});
    }
  }
  return cycles.sort((a,b)=>a.first_contact-b.first_contact||a.id.localeCompare(b.id));
}
function identityMap(crm){
  const parents=new Map(),find=k=>{if(!parents.has(k))parents.set(k,k);if(parents.get(k)!==k)parents.set(k,find(parents.get(k)));return parents.get(k);};
  const aliases=new Map();
  for(const o of crm.opportunities.filter(realOpportunity)){
    const contact=(crm.contacts||[]).find(c=>c.id===o.contact),keys=['conversation:'+o.conversation];
    if(o.contact)keys.push('contact:'+o.contact);
    for(const link of crm.client_links||[])if(link.conversation===o.conversation&&link.client_id)keys.push('cash:'+link.client_id);
    const phone=contactPhoneKey(contact?.phone||(o.channel==='whatsapp'?o.customer:''));if(phone)keys.push('phone:'+phone);
    for(const b of crm.bookings||[])if(b.conversation===o.conversation&&b.quote?.clientId)keys.push('cash:'+b.quote.clientId);
    for(const check of crm.campaign_checks||[])if(check.conversation===o.conversation&&check.report?.client_id)keys.push('cash:'+check.report.client_id);
    for(const key of keys)parents.set(find(key),find(keys[0]));
    aliases.set(o.conversation,keys[0]);
  }
  return new Map([...aliases].map(([id,key])=>[id,find(key)]));
}
function included(row,f,stamp){
  if(f.from&&stamp<Date.parse(f.from+'T00:00:00-03:00')||f.to&&stamp>Date.parse(f.to+'T23:59:59.999-03:00'))return false;
  if(f.channel&&![row.channel,row.account].includes(f.channel)||f.owner&&row.owner!==f.owner||f.campaign&&row.campaign!==f.campaign||f.ad&&row.ad_id!==f.ad)return false;
  const query=String(f.query||f.bookingQuery||'').trim().toLocaleLowerCase('pt-BR');
  return !query||`${row.client} ${row.phone} ${row.campaign_name} ${row.ad_name} ${(row.services||[]).map(s=>s.name).join(' ')}`.toLocaleLowerCase('pt-BR').includes(query);
}
export function campaignAnalysis(crm,filters={},now=Date.now()){
  const cycles=attendanceCycles(crm,now),identities=identityMap(crm);
  for(const c of cycles)c.client_key=identities.get(c.conversation)||c.conversation;
  const journeys=[],anchors=new Map();
  for(const cycle of cycles){
    const anchor=anchors.get(cycle.client_key);
    if(cycle.source!=='paid'&&anchor&&cycle.first_contact-anchor.first_contact<=directContinuationDays*day){
      anchor.continuations.push(cycle);anchor.services.push(...cycle.services);anchor.events.push(...cycle.events);
      anchor.value_cents+=cycle.value_cents;anchor.unknown_value+=cycle.unknown_value;anchor.sales+=cycle.sales;anchor.revenue_cents+=cycle.revenue_cents;anchor.performed+=cycle.performed;
      anchor.until=Math.max(anchor.until===Infinity?cycle.until:anchor.until,cycle.until);anchor.current=cycle.current;anchor.status=cycle.status;anchor.closed_at=cycle.closed_at;
      if(cycle.outcome==='scheduled')anchor.outcome='scheduled';else if(anchor.outcome!=='scheduled')anchor.outcome=cycle.outcome;
      if(cycle.conversion_at!==null)anchor.conversion_at=anchor.conversion_at===null?cycle.conversion_at:Math.min(anchor.conversion_at,cycle.conversion_at);
      continue;
    }
    if(anchor)anchor.until=Math.min(anchor.until,cycle.first_contact);
    const journey={...cycle,services:[...cycle.services],events:[...cycle.events],continuations:[]};journeys.push(journey);
    if(cycle.source==='paid'&&cycle.ad_id)anchors.set(cycle.client_key,journey);
    else anchors.delete(cycle.client_key);
  }
  const direct=journeys.filter(c=>c.source==='paid'&&c.ad_id&&included(c,filters,c.first_contact)&&(!filters.outcome||c.outcome===filters.outcome)&&(!filters.status||c.status===filters.status));
  const groups=new Map();
  for(const c of direct){
    if(!groups.has(c.campaign))groups.set(c.campaign,{id:c.campaign,name:c.campaign_name,attendances:0,clients:new Set(),scheduled:0,services:0,value_cents:0,unknown_value:0,performed:0,revenue_cents:0,sales:0});
    const g=groups.get(c.campaign);g.attendances++;g.clients.add(c.client_key);g.scheduled+=c.outcome==='scheduled';g.services+=c.services.length;g.value_cents+=c.value_cents;g.unknown_value+=c.unknown_value;g.performed+=c.performed;g.revenue_cents+=c.revenue_cents;g.sales+=c.sales;
  }
  const people=new Map();for(const c of journeys){if(!people.has(c.client_key))people.set(c.client_key,[]);people.get(c.client_key).push(c);}
  const acquisition=[];
  for(const [client_key,attendances]of people){
    const first=attendances[0];if(first.source!=='paid'||!first.ad_id||!included({...first,services:attendances.flatMap(c=>c.services)},filters,first.first_contact))continue;
    const conversions=attendances.filter(c=>c.outcome==='scheduled'),converted=conversions[0],returns=conversions.filter(c=>c.id!==first.id),later=attendances.slice(1);
    const services=attendances.flatMap(c=>c.services.map(s=>({...s,cycle:c.id,source:c.source,at:c.first_contact,conversion_at:c.conversion_at}))),sales=attendances.flatMap(c=>c.events.filter(e=>e.kind==='sale'));
    const windows=Object.fromEntries([30,60,90].map(days=>{const end=first.first_contact+days*day;const subset=services.filter(s=>s.created_at<=end),events=sales.filter(e=>e.occurred<=end);return [days,{mature:now>=end,services:subset.length,value_cents:subset.reduce((sum,s)=>sum+(s.price_cents??0),0),revenue_cents:events.reduce((sum,e)=>sum+(Number(e.amount_cents)||0),0)}];}));
    acquisition.push({...first,id:client_key,client_key,attendances,services,converted:!!converted,first_conversion_at:converted?.conversion_at??null,first_conversion_return:!!converted&&converted.id!==first.id,first_conversion_source:converted?.source||null,return_converted:returns.length>0,spontaneous_returns:returns.filter(c=>c.source!=='paid').length,paid_returns:returns.filter(c=>c.source==='paid').length,repeat_conversions:Math.max(0,conversions.length-1),return_attendances:later.length,value_cents:services.reduce((sum,s)=>sum+(s.price_cents??0),0),unknown_value:services.filter(s=>s.price_cents===null).length,revenue_cents:sales.reduce((sum,e)=>sum+(Number(e.amount_cents)||0),0),windows,delay_ms:converted?.conversion_at!=null?converted.conversion_at-first.first_contact:null});
  }
  const counts=Object.fromEntries(['scheduled','not_scheduled','information','pending','unknown'].map(k=>[k,direct.filter(c=>c.outcome===k).length]));
  return {direct:direct.sort((a,b)=>b.first_contact-a.first_contact||a.id.localeCompare(b.id)),counts,groups:[...groups.values()].map(g=>({...g,clients:g.clients.size,rate:g.attendances?g.scheduled/g.attendances:null})),acquisition:acquisition.sort((a,b)=>b.first_contact-a.first_contact),summary:{attendances:direct.length,clients:new Set(direct.map(c=>c.client_key)).size,scheduled:counts.scheduled,services:direct.reduce((sum,c)=>sum+c.services.length,0),value_cents:direct.reduce((sum,c)=>sum+c.value_cents,0),acquired:acquisition.length,converted:acquisition.filter(c=>c.converted).length,first_conversion_return:acquisition.filter(c=>c.first_conversion_return).length,return_converted:acquisition.filter(c=>c.return_converted).length}};
}

export function campaignAnalysisCsv(report,view='direct'){
  const data=view==='acquisition'?[['Cliente','Primeiro contato registrado','Campanha de aquisição','Anúncio','Converteu','Primeira conversão no retorno','Primeira conversão','Retornos espontâneos com agendamento','Retornos pagos com agendamento','Serviços','Valor agendado centavos','Vendas registradas centavos'],...report.acquisition.map(c=>[c.client,new Date(c.first_contact).toISOString(),c.campaign_name,c.ad_id,c.converted?'Sim':'Não',c.first_conversion_return?'Sim':'Não',c.first_conversion_at?new Date(c.first_conversion_at).toISOString():'',c.spontaneous_returns,c.paid_returns,c.services.map(s=>s.name).join(' | '),c.value_cents,c.revenue_cents])]:[['Cliente','Início do atendimento','Campanha','Anúncio','Origem','Resultado','Serviço anunciado','Serviços agendados','Valor agendado centavos','Vendas registradas centavos','Conversa','Ciclo'],...report.direct.map(c=>[c.client,new Date(c.first_contact).toISOString(),c.campaign_name,c.ad_id,c.identification,c.outcome,c.advertised_service,c.services.map(s=>s.name).join(' | '),c.value_cents,c.revenue_cents,c.conversation,c.id])];
  return '\ufeff'+data.map(row=>row.map(v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}).join(';')).join('\r\n');
}
