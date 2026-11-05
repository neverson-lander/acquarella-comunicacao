import {cashError,externalId} from '../vercel-app/lib/cashbarber-domain.mjs';
import {creationTimestamp} from './campaign-bookings.mjs';
import {calendarDate} from './calendar.mjs';
import {normalizeContactPhone} from '../vercel-app/public/contact-domain.mjs';

export async function notificationAppointment(api,tenant,id){
  id=externalId(id);let raw;
  try{raw=await api.request(tenant,'agendamentos/'+id);}catch(e){if(e.providerStatus===404)return {id,active:false};throw e;}
  if(String(raw?.id)!==id||String(raw.age_id_filial)!==await api.branch(tenant))throw cashError('Reserva fora da filial conectada.',403);
  // The scheduling feed also contains blocked periods without a customer.
  // Ignore those records before trying to resolve customer/service identifiers.
  const active=raw.age_tipo==='Agendamento'&&![0,'0',false].includes(raw.age_active)&&!/finaliz|cancel|exclu|delet|faltou/i.test(String(raw.age_status||'')+' '+String(raw.age_cliente_status||''));
  if(!active)return {id,active:false};
  const start=String(raw.age_inicio||'').replace(' ','T');
  const startsAt=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(start)?Date.parse(start+'-03:00'):Date.parse(start);
  const customer=await api.request(tenant,'clientes/'+externalId(raw.age_id_cliente));
  if(String(customer?.id)!==String(raw.age_id_cliente))throw cashError('Cliente da reserva não reconhecido.',502);
  let phone='';try{phone=normalizeContactPhone(String(customer.cli_telefone||raw.cliente?.cli_telefone||''));}catch{}
  return {id,active,clientId:externalId(raw.age_id_cliente),clientName:String(customer.cli_name||raw.cliente?.cli_name||''),email:String(customer.email||customer.cli_email||''),phone,startsAt:Number.isSafeInteger(startsAt)?startsAt:null,createdAt:creationTimestamp(raw.created_at),professionalName:String(raw.user?.usu_name||''),services:(raw.agendamento_servicos||[]).map(s=>({id:externalId(s.ags_id_servico),name:String(s.servico?.ser_nome||'')}))};
}
export async function notificationAgenda(api,tenant,input){
  const date=calendarDate(input.date),data=await api.request(tenant,'agendamentos/list',{data_inicio:date+' 00:00:00',data_fim:date+' 23:59:59',id_filial:await api.branch(tenant),incluir_comanda_nao_finalizada:true});
  if(!Array.isArray(data?.agendamentos))throw cashError('Agenda não reconhecida.',502);
  // Optional grouping metadata lets the worker fetch all of a customer's daily
  // bookings, including siblings outside its current page of appointment IDs.
  return {ids:[...new Set(data.agendamentos.map(e=>externalId(e.id)))],...(input.grouping?{groups:data.agendamentos.map(e=>({id:externalId(e.id),clientId:String(e.id_cliente||e.age_id_cliente||''),date:String(e.start||e.age_inicio||'').slice(0,10)}))}:{})};
}
