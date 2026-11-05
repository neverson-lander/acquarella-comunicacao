import {createCashbarberClient} from './cashbarber-client.mjs';
import {externalId,cashError,appointmentPeriod} from './cashbarber-domain.mjs';
export function createExternalScheduling({client=createCashbarberClient()}={}){
 return async function resolveExternalScheduling(user,input){
  if(client.forUser)return createExternalScheduling({client:client.forUser(user)})(user,input);
  if(!input||typeof input!=='object'||Array.isArray(input))throw cashError('Consulte o cliente, a profissional e os serviços no CashBarber antes de encerrar.');
  if(input.appointment_ids!==undefined){
   if(!Array.isArray(input.appointment_ids)||!input.appointment_ids.length||input.appointment_ids.length>20)throw cashError('Selecione de 1 a 20 agendamentos existentes.');
   const ids=input.appointment_ids.map(externalId),clientId=externalId(input.client_id);
   if(new Set(ids).size!==ids.length)throw cashError('Não repita o mesmo agendamento.');
   const {appointments}=await client.call(user.tenant,'appointments',{client_id:clientId,...appointmentPeriod(input)});
   const selected=ids.map(id=>appointments?.find(a=>a.id===id&&a.client_id===clientId));
   if(selected.some(a=>!a||!a.services?.length))throw cashError('Um agendamento não está mais disponível. Consulte novamente o CashBarber.',409);
   return {client_id:clientId,client_name:selected[0].client_name,client_not_found:false,services:selected.flatMap(a=>a.services.map(s=>({id:'cashbarber-appointment:'+a.id+':'+s.id,name:s.name,professional:a.professional,professional_id:a.professional_id,service_id:s.id,client:a.client_name,client_id:clientId,source:'cashbarber_external',external_appointment_id:a.id,date:a.date,start:a.start})))};
  }
  const rows=input.services;
  if(!Array.isArray(rows)||!rows.length||rows.length>20)throw cashError('Informe ao menos uma profissional e serviço consultados no CashBarber.');
  const selected=rows.map(r=>({professional_id:externalId(r?.professional_id),service_id:externalId(r?.service_id)}));
  if(new Set(selected.map(r=>r.professional_id+':'+r.service_id)).size!==selected.length)throw cashError('Não repita o mesmo serviço para a mesma profissional.');
  if(input.client_not_found!==true&&!input.client_id)throw cashError('Selecione o cliente ou confirme que não foi localizado na busca.');
  if(input.client_not_found===true&&input.client_id)throw cashError('Confira a identificação do cliente.');
  const search=typeof input.client_search==='string'?input.client_search.trim():'';
  if(input.client_not_found===true&&(search.length<3||search.length>100))throw cashError('Busque o cliente antes de informar que ele não foi localizado.');
  let customer=null;
  if(input.client_id){const result=await client.call(user.tenant,'client',{id:externalId(input.client_id)});customer=result.client;if(!customer?.name||String(customer.id)!==String(input.client_id))throw cashError('Cliente não localizado no CashBarber.');}
  else await client.call(user.tenant,'clients',{search});
  const {professionals}=await client.call(user.tenant,'professionals',{}),directory=new Map(),services=[];
  for(const row of selected){
   const professional=professionals?.find(p=>String(p.id)===row.professional_id);if(!professional)throw cashError('Profissional não disponível no CashBarber.');
   if(!directory.has(row.professional_id))directory.set(row.professional_id,await client.call(user.tenant,'services',{id:row.professional_id}));
   const service=directory.get(row.professional_id).services?.find(s=>String(s.id)===row.service_id);if(!service?.name)throw cashError('Este serviço não está disponível para a profissional no CashBarber.');
   services.push({id:'cashbarber-service:'+row.professional_id+':'+row.service_id,name:service.name,professional:professional.name,professional_id:row.professional_id,service_id:row.service_id,client:customer?.name||'',client_id:customer?String(customer.id):null,source:'cashbarber_external'});
  }
  return {services,client_id:customer?String(customer.id):null,client_name:customer?.name||'',client_not_found:!customer};
 };
}
