import {realOpportunity,touchAt,summarize,SOURCES} from './crm-domain.mjs';
import {metricsCrm} from './metrics-scope.mjs';
export function bookingServiceDate(value){
 const date=String(value||'');
 return /^\d{4}-\d{2}-\d{2}$/.test(date)?date.split('-').reverse().join('/'):date;
}

export function cashbarberRecords(crm,now=Date.now(),{includeBulk=false}={}){
 if(!includeBulk)crm=metricsCrm(crm);
 const visible=new Map(crm.opportunities.filter(realOpportunity).map(o=>[o.conversation,o])),records=[],ids=new Set(),byExternal=new Map();
 const add=b=>{
  if(!visible.has(b.conversation)||ids.has(b.id))return;
  const external=String(b.receipt?.externalId||''),q=b.quote||{};
  const related=byExternal.get(external)||[];
  if(external&&related.some(r=>q.serviceId&&r.quote?.serviceId?String(q.serviceId)===String(r.quote.serviceId):String(q.service||'').trim().toLowerCase()===String(r.quote?.service||'').trim().toLowerCase()))return;
  ids.add(b.id);records.push(b);
  if(external){related.push(b);byExternal.set(external,related);}
 };
 for(const b of [...crm.bookings||[]].sort((a,b)=>Number(a.confirmed_at)-Number(b.confirmed_at)||String(a.id).localeCompare(String(b.id))))if(Number(b.confirmed_at)<=now)add(b);
 const checks=[...crm.campaign_checks||[]].sort((a,b)=>(visible.get(a.conversation)?.first_contact||0)-(visible.get(b.conversation)?.first_contact||0)||Number(a.checked_at)-Number(b.checked_at)||String(a.conversation).localeCompare(String(b.conversation)));
 for(const check of checks){
  const report=check.report;
  if(report?.status!=='matched'||Number(report.checked_at||check.checked_at)>now)continue;
  for(const match of report.matches||[]){
   if(!match.id||!Number.isSafeInteger(Number(match.created_at))||Number(match.created_at)<=0||Number(match.created_at)>now||/cancel|exclu|delet/i.test(match.status||''))continue;
   const services=match.service_details?.length?match.service_details:(match.services||[]).map(name=>({name,price_cents:match.services.length===1?match.amount_cents:null}));
   services.forEach((s,index)=>add({id:'queried:'+match.id+':'+(s.id||index),conversation:check.conversation,confirmed_at:Number(match.created_at),actor:null,queried:true,receipt:{externalId:String(match.id)},quote:{clientId:report.client_id,clientName:report.client_name,service:s.name,serviceId:s.id,professionalName:match.professional,date:match.date,start:match.start,end:match.end||'',price:Number.isSafeInteger(s.price_cents)&&s.price_cents>=0?s.price_cents:null}}));
  }
 }
 return records;
}

export function bookingReport(crm,{from='',to='',channel='',owner='',grouping='campaign',bookingQuery=''}={},now=Date.now()){
  crm=metricsCrm(crm);
  const start=from?Date.parse(from+'T00:00:00-03:00'):0,end=Math.min(now,to?Date.parse(to+'T23:59:59.999-03:00'):now);
  const opportunities=new Map(crm.opportunities.filter(o=>realOpportunity(o)&&(!channel||o.channel===channel)&&(!owner||o.owner===owner)).map(o=>[o.conversation,o]));
  const groups=new Map(),seen=new Set(),clients=new Set(),rows=[];
  const query=bookingQuery.trim().toLocaleLowerCase('pt-BR');
  for(const b of cashbarberRecords(crm,now)){
    const o=opportunities.get(b.conversation),q=b.quote||{},confirmed=Number(b.confirmed_at);
    if(!o||seen.has(b.id)||!Number.isFinite(confirmed)||confirmed<start||confirmed>end||(!Number.isSafeInteger(q.price)||q.price<0)&&!(b.queried&&q.price===null))continue;
    seen.add(b.id);
    const sourceTouches=crm.touches.filter(t=>t.opportunity===o.id&&t.created<=now),touch=touchAt(sourceTouches,confirmed),touches=[{...touch,referral:{...touch.referral,attendance_start:undefined}}];
    const ad={...crm.ads.find(a=>a.ad_id===touch.ad_id),...touch.meta_snapshot};
    const key=summarize([{...o,touches,ad}],[],[],'first',grouping).groups[0].key;
    const row={id:b.id,conversation:b.conversation,confirmed_at:confirmed,client_id:q.clientId,client:q.clientName||o.customer_name||o.customer,customer:o.customer,service:q.service,professional:q.professionalName,date:q.date,start:q.start,end:q.end,price_cents:q.price,external_id:b.receipt?.externalId||'',channel:o.channel,actor_id:b.queried?'cashbarber_external':b.actor,actor:b.queried?'Encontrado no CashBarber':crm.team.find(u=>u.id===b.actor)?.name||'Operador não identificado',queried:!!b.queried,campaign:key,campaign_name:ad.campaign_name||ad.campaign_id||SOURCES[touch.source]||'Não identificada',ad_id:touch.ad_id||'',ad_name:ad.ad_name||'',source:SOURCES[touch.source]||'Não identificada',identification:touch.evidence==='manual'?'Manual':touch.evidence==='webhook'?'Automática':'Não identificada'};
    if(query&&!`${row.client} ${row.customer} ${row.client_id} ${row.service} ${row.campaign} ${row.campaign_name} ${row.ad_name} ${row.ad_id}`.toLocaleLowerCase('pt-BR').includes(query))continue;
    const clientKey=String(q.clientId||o.contact||o.id);clients.add(clientKey);rows.push(row);
    if(!groups.has(key))groups.set(key,{key,count:0,clients:new Set(),value_cents:0,unknown_value:0,manual:0,automatic:0});
    const group=groups.get(key);group.count++;group.clients.add(clientKey);group.value_cents+=q.price??0;if(q.price===null)group.unknown_value++;
    if(touch.evidence==='manual')group.manual++;else if(touch.evidence==='webhook')group.automatic++;
  }
  return {count:rows.length,clients:clients.size,unknown_value:rows.filter(r=>r.price_cents===null).length,queried:rows.filter(r=>r.queried).length,value_cents:rows.reduce((sum,r)=>sum+(r.price_cents??0),0),rows:rows.sort((a,b)=>b.confirmed_at-a.confirmed_at||a.id.localeCompare(b.id)),groups:[...groups.values()].map(g=>({...g,clients:g.clients.size})).sort((a,b)=>b.value_cents-a.value_cents||b.count-a.count||a.key.localeCompare(b.key))};
}
