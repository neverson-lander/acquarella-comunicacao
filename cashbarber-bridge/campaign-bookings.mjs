import {cashError,externalId} from '../vercel-app/lib/cashbarber-domain.mjs';

// CashBarber's scheduling API exposes created_at on GET /agendamentos/{id}.
// Never substitute the service date or updated_at for the creation timestamp.
export function creationTimestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;
 const date=value.slice(0,10),day=Date.parse(date+'T12:00:00Z');if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==date)return null;
 const stamp=Date.parse(value.replace(' ','T'));
 return Number.isFinite(stamp)?stamp:null;
}
export function consultationRange(input){
 const dates=['from','to'].map(key=>{const value=String(input[key]||''),stamp=Date.parse(value+'T12:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==value)throw cashError('Período de consulta inválido.');return {value,stamp};});
 if(dates[1].stamp<dates[0].stamp||dates[1].stamp-dates[0].stamp>92*86400000)throw cashError('Consulte até 93 dias de agenda por vez.');
 return {from:dates[0].value,to:dates[1].value};
}
export function bookedAmount(value){
 if(value===null||value===undefined||value===''||!['string','number'].includes(typeof value))return null;
 const text=String(value).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(text))return null;
 const amount=Math.round(Number(text)*100);return Number.isSafeInteger(amount)?amount:null;
}
export async function campaignBookings(api,tenant,input){
 const {from,to}=consultationRange(input),clientId=externalId(input.client_id),since=Number(input.since),until=Number(input.until);
 if(!Number.isSafeInteger(since)||!Number.isSafeInteger(until)||since<=0||until<since)throw cashError('Referência da campanha inválida.');
 const customer=await api.customer(tenant,clientId),branch=await api.branch(tenant);
 const data=await api.request(tenant,'agendamentos/list',{data_inicio:from+' 00:00:00',data_fim:to+' 23:59:59',id_filial:branch,incluir_comanda_nao_finalizada:true});
 if(!Array.isArray(data?.agendamentos))throw cashError('Agenda CashBarber não reconhecida.',502);
 const events=data.agendamentos.filter(e=>String(e.id_cliente)===clientId),matches=[],unknown=[];
 // Limit detail reads; incomplete scans always remain explicitly inconclusive.
 const queue=events.slice(0,40);let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
  while(cursor<queue.length){
   const event=queue[cursor++],id=externalId(event.id);
   const raw=await api.request(tenant,'agendamentos/'+id);
   if(String(raw?.id)!==id||String(raw.age_id_cliente)!==clientId||String(raw.age_id_filial)!==branch)throw cashError('Dados do agendamento não correspondem ao cliente e à filial.',502);
   const created=creationTimestamp(raw.created_at),status=String(raw.age_status||event.age_status||event.status||'');
   if(raw.age_active===false||raw.age_active===0||/cancel|exclu|delet/i.test(status))continue;
   if(created===null){unknown.push(id);continue;}
   if(created<=since||created>until)continue;
   const services=raw.agendamento_servicos||event.agendamento_servicos;
   if(!Array.isArray(services))throw cashError('Serviços do agendamento não reconhecidos.',502);
   const service_details=services.map(s=>({id:String(s.ags_id_servico||s.servico?.id||''),name:String(s.servico?.ser_nome||'Serviço não informado'),price_cents:bookedAmount(s.ags_valor)}));
   const amount_cents=service_details.length&&service_details.every(s=>s.price_cents!==null)?service_details.reduce((sum,s)=>sum+s.price_cents,0):null;
   matches.push({id,created_at:created,date:String(raw.age_inicio||event.start||'').slice(0,10),start:String(raw.age_inicio||event.start||'').slice(11,16),professional:String(raw.user?.usu_name||data.barbeiros?.find(p=>String(p.id)===String(event.id_barbeiro))?.usu_name||'Não informado'),services:service_details.map(s=>s.name),service_details,amount_cents,status});
  }
 }));
 const incomplete=events.length>queue.length;
 return {status:matches.length?'matched':unknown.length||incomplete?'inconclusive':'none_in_period',client_id:clientId,client_name:customer.name,from,to,since,until,checked_at:Date.now(),matches:matches.sort((a,b)=>a.created_at-b.created_at||a.id.localeCompare(b.id)),unknown_creation:unknown.length,incomplete,total_amount_cents:matches.length&&matches.every(m=>m.amount_cents!==null)?matches.reduce((sum,m)=>sum+m.amount_cents,0):null};
}
