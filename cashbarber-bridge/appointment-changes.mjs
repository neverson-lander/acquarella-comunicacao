import {createHash} from 'node:crypto';
import {journalTenant} from './session-scope.mjs';
import {cashError,externalId,bookingInput,availableSlots,minutes,clock} from '../vercel-app/lib/cashbarber-domain.mjs';
import {apiCalendar} from './api-calendar.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const stamp=v=>{const s=String(v||'').replace('T',' ').slice(0,16);if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s))throw cashError('Horário do agendamento não reconhecido.',502);minutes(s.slice(11));return s;};
const cents=v=>v!==null&&v!==''&&['string','number'].includes(typeof v)&&Number.isFinite(Number(v))&&Number(v)>=0?Math.round(Number(v)*100):null;
export async function upcomingAppointments(api,tenant,input){
 const clientId=externalId(input.clientId),from=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),until=new Date(Date.parse(from+'T12:00:00Z')+90*86400000).toISOString().slice(0,10),branch=await api.branch(tenant);
 const [customer,data]=await Promise.all([api.request(tenant,'clientes/'+clientId),api.request(tenant,'agendamentos/list',{data_inicio:from+' 00:00:00',data_fim:until+' 23:59:59',id_filial:branch,incluir_comanda_nao_finalizada:true})]);
 if(String(customer?.id)!==clientId||!Array.isArray(data?.agendamentos)||!Array.isArray(data.barbeiros))throw cashError('Consulta de próximos agendamentos não reconhecida.',502);
 const rows=[];
 for(const e of data.agendamentos){
  if(String(e.id_cliente)!==clientId||[0,'0',false].includes(e.age_active)||/finaliz|cancel|exclu|delet/i.test(String(e.age_status||e.status||'')))continue;
  const start=stamp(e.start);if(start.slice(0,10)<from||start.slice(0,10)>until||Date.parse(start.replace(' ','T')+':00-03:00')<=Date.now())continue;
  if(!Array.isArray(e.agendamento_servicos))throw cashError('Serviços da reserva não reconhecidos.',502);
  const services=e.agendamento_servicos.map(s=>({id:externalId(s.ags_id_servico??s.servico?.id),name:String(s.servico?.ser_nome||'')}));if(!services.length)continue;
  rows.push({id:externalId(e.id),client_id:clientId,client_name:String(customer.cli_name||''),date:start.slice(0,10),start:start.slice(11),professional_id:externalId(e.id_barbeiro),professional:String(data.barbeiros.find(p=>String(p.id)===String(e.id_barbeiro))?.usu_name||'Profissional não informada'),status:String(e.age_status||e.status||'Agendado'),services});
 }
 const appointments=[...new Map(rows.map(r=>[r.id,r])).values()].sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
 return {appointments:appointments.slice(0,30),hasMore:appointments.length>30,from,until};
}
export async function appointment(api,tenant,input,{allowMissing=false}={}){
 const id=externalId(input.id),clientId=externalId(input.clientId);let raw;
 try{raw=await api.request(tenant,'agendamentos/'+id);}catch(e){if(allowMissing&&e.providerStatus===404)return null;throw e;}
 if(String(raw?.id)!==id||String(raw.age_id_cliente)!==clientId||String(raw.age_id_filial)!==await api.branch(tenant))throw cashError('Agendamento não pertence ao cliente vinculado ou à filial conectada.',403);
 if(!Array.isArray(raw.agendamento_servicos)||!raw.agendamento_servicos.length)throw cashError('Serviços do agendamento não reconhecidos.',502);
 const start=stamp(raw.age_inicio),end=stamp(raw.age_fim);
 const services=raw.agendamento_servicos.map(s=>({id:externalId(s.ags_id_servico),name:String(s.servico?.ser_nome||''),price:cents(s.ags_valor)}));
 const comanda=raw.comanda_agendamento?.comanda,reason=raw.age_tipo!=='Agendamento'?'Este registro não é um agendamento de serviço.':/finaliz|cancel|exclu|delet/i.test(String(raw.age_status||''))||/faltou/i.test(String(raw.age_cliente_status||''))||[0,'0',false].includes(raw.age_active)?'Agendamento finalizado, cancelado ou com falta registrada.':comanda&&Number(comanda.com_active)===1&&Number(comanda.com_pago)===0?'O agendamento possui comanda aberta. Finalize a comanda no CashBarber antes de alterar.':'';
 const data={id,clientId,branchId:String(raw.age_id_filial),clientName:String(raw.cliente?.cli_name||''),professionalId:externalId(raw.age_id_user),professionalName:String(raw.user?.usu_name||''),date:start.slice(0,10),start:start.slice(11),end:end.slice(11),services,price:services.every(s=>s.price!==null)?services.reduce((n,s)=>n+s.price,0):null,status:String(raw.age_status||''),active:![0,'0',false].includes(raw.age_active),notes:String(raw.age_observacao||''),noPreference:[true,1,'1'].includes(raw.age_sem_preferencia),reason};
 return {...data,version:hash({...data,updated:raw.updated_at,clientStatus:raw.age_cliente_status,comanda:comanda?{id:comanda.id,active:comanda.com_active,paid:comanda.com_pago}:null})};
}
export async function changePreview(api,tenant,input){
 if(!['update','cancel'].includes(input.kind))throw cashError('Selecione alteração ou exclusão.');
 const before=await appointment(api,tenant,input);if(before.reason)throw cashError(before.reason,409);
 if(input.kind==='cancel')return {kind:'cancel',before,after:null,payload:null,available:true};
 if(!Array.isArray(input.services)||!input.services.length||input.services.length>10)throw cashError('Selecione de 1 a 10 serviços.');
 const ids=input.services.map(externalId);if(new Set(ids).size!==ids.length)throw cashError('Não repita o mesmo serviço.');
 const details=bookingInput({...input,clientId:before.clientId,service:ids[0]}),people=await api.directory(tenant,true),professional=people.find(p=>p.id===details.professionalId);
 const selected=ids.map(id=>professional?.services.find(s=>s.id===id));if(selected.some(s=>!s))throw cashError('Um serviço não está disponível para a profissional selecionada.',409);
 const duration=selected.reduce((n,s)=>n+s.duration,0);if(duration>720||minutes(details.start)+duration>=1440)throw cashError('A duração ultrapassa os limites do dia.');
 const prices=await Promise.all(selected.map(s=>api.request(tenant,'clientes/servico/preco',{cli_id:Number(before.clientId),servico_id:Number(s.id),age_inicio:details.date,usu_id:Number(professional.id)})));
 const services=selected.map((s,i)=>({id:s.id,name:s.name,price:cents(prices[i])}));if(services.some(s=>s.price===null))throw cashError('Preço do cliente não confirmado.',502);
 const data=await api.request(tenant,'agendamentos/list',{data_inicio:details.date+' 00:00:00',data_fim:details.date+' 23:59:59',id_filial:before.branchId,incluir_comanda_nao_finalizada:true});
 if(!Array.isArray(data.agendamentos))throw cashError('Agenda não reconhecida.',502);
 const calendar=apiCalendar({...data,agendamentos:data.agendamentos.filter(e=>String(e.id)!==before.id)},details.date,people),person=calendar.professionals.find(p=>p.id===professional.id);
 if(!person||person.error)throw cashError(person?.error||'Agenda indisponível para esta profissional.',409);
 const slots=availableSlots({date:details.date,duration,work:person.windows});
 const after={...before,professionalId:professional.id,professionalName:professional.name,date:details.date,start:details.start,end:clock(minutes(details.start)+duration),services,price:services.reduce((n,s)=>n+s.price,0),duration};delete after.version;
 const payload={age_id:Number(before.id),age_id_cliente:Number(before.clientId),age_id_user:Number(after.professionalId),age_id_filial:Number(before.branchId),age_inicio:after.date+' '+after.start,age_fim:after.date+' '+after.end,age_tipo:'Agendamento',age_observacao:before.notes,age_sem_preferencia:before.noPreference,servicos:services.map(s=>Number(s.id))};
 const preview={kind:'update',before,after,payload,available:slots.includes(after.start),slots,warnings:[]};
 const check=await api.request(tenant,'agendamentos/check',payload);
 if(!check||!['indisponivel','duplicado','inadimplente','intervalo'].every(k=>Object.hasOwn(check,k)))throw cashError('Conferência de conflitos não reconhecida.',502);
 if(check.indisponivel||check.inadimplente||check.intervalo){
  preview.available=false;
  preview.reason=check.inadimplente?'O CashBarber informou uma restrição do cliente. Confira no CashBarber antes de alterar.':'O início escolhido tem conflito ou intervalo. Selecione um dos horários livres abaixo.';
 }
 if(check.duplicado&&!await duplicateIsCurrent(api,tenant,preview,check.duplicado)){
  let when='';try{when=stamp(check.duplicado.age_inicio);}catch{}
  preview.warnings.push('O cliente já possui outro agendamento de um dos serviços'+(when?' em '+when:'')+'. Confira esse registro antes de confirmar. Esta alteração mantém somente o agendamento '+before.id+'.');
 }
 return preview;
}
function matches(a,b){return a&&b&&['id','clientId','branchId','professionalId','date','start','end','price'].every(k=>a[k]===b[k])&&hash(a.services.map(s=>[s.id,s.price]).sort())===hash(b.services.map(s=>[s.id,s.price]).sort());}
export async function changeReconcile(api,tenant,input){
 const key=changeKey(tenant,input.operation),saved=await api.vault.read(key);
 if(!saved){
  if(['update','cancel'].includes(input.kind)&&Number.isSafeInteger(input.startedAt)&&input.startedAt<=Date.now()-120000)return {state:'rejected',kind:input.kind,externalId:externalId(input.externalId),message:'O conector não iniciou a gravação desta tentativa. Consulte o agendamento novamente.'};
  throw cashError('Aguarde dois minutos e verifique novamente: o conector ainda não registrou esta tentativa.',409);
 }
 if(['confirmed','rejected'].includes(saved.state))return saved.result;
 const current=await appointment(api,tenant,saved.preview.before,{allowMissing:true});
 const confirmed=saved.preview.kind==='cancel'?!current||!current.active||/cancel|exclu|delet/i.test(current.status):matches(current,saved.preview.after);
 const result={state:confirmed?'confirmed':'uncertain',kind:saved.preview.kind,externalId:saved.preview.before.id,before:saved.preview.before,after:current,message:confirmed?(saved.preview.kind==='cancel'?'Exclusão confirmada no CashBarber.':'Alteração confirmada no CashBarber.'):'Resultado ainda não confirmado. Verifique o registro; a gravação não será repetida.'};
 await api.vault.write(key,{...saved,state:result.state,result});return result;
}
const changeKey=(tenant,operation)=>{if(!/^[a-f0-9-]{36}$/i.test(operation||''))throw cashError('Operação inválida.');return 'change_'+journalTenant(tenant)+'_'+operation;};
export async function duplicateIsCurrent(api,tenant,preview,duplicate){
 // CashBarber's check returns only age_inicio and may include the record being edited.
 // Confirm the identity from the day's schedule; never ignore a boolean or an unknown duplicate.
 if(!duplicate||typeof duplicate!=='object'||stamp(duplicate.age_inicio)!==preview.before.date+' '+preview.before.start)return false;
 const before=preview.before,events=[];
 for(const date of new Set([before.date,preview.after.date])){
  const data=await api.request(tenant,'agendamentos/list',{data_inicio:date+' 00:00:00',data_fim:date+' 23:59:59',id_filial:before.branchId,incluir_comanda_nao_finalizada:true});if(!Array.isArray(data.agendamentos))return false;events.push(...data.agendamentos);
 }
 const selected=new Set(preview.after.services.map(s=>s.id)),candidates=[...new Map(events.map(e=>[String(e.id),e])).values()].filter(e=>String(e.id_cliente)===before.clientId&&!/cancel|exclu|delet/i.test(String(e.age_status||e.status||'')));
 if(candidates.some(e=>!Array.isArray(e.agendamento_servicos)))return false;
 const matching=candidates.filter(e=>e.agendamento_servicos.some(s=>selected.has(String(s.ags_id_servico??s.servico?.id))));
 return matching.length===1&&String(matching[0].id)===before.id&&stamp(matching[0].start)===before.date+' '+before.start;
}
export async function changeCommit(api,tenant,input){
 const key=changeKey(tenant,input.operation),fingerprint=hash(input.preview),saved=await api.vault.read(key);
 if(saved){if(saved.fingerprint!==fingerprint)throw cashError('Identificador já usado em outra alteração.',409);return changeReconcile(api,tenant,input);}
 const preview=input.preview;if(!preview?.before?.version)throw cashError('Confira o agendamento antes de confirmar.');
 let latest;
 try{
  latest=await changePreview(api,tenant,{kind:preview.kind,id:preview.before.id,clientId:preview.before.clientId,...(preview.after?{professionalId:preview.after.professionalId,services:preview.after.services.map(s=>s.id),date:preview.after.date,start:preview.after.start}:{})});
  if(latest.before.version!==preview.before.version||!latest.available||preview.kind==='update'&&(!matches(latest.after,preview.after)||hash(latest.warnings)!==hash(preview.warnings)))throw cashError('O agendamento, preço, disponibilidade ou avisos mudaram. Consulte novamente.',409);
 }catch(e){return {state:'rejected',kind:preview.kind,externalId:preview.before.id,message:e.status?e.message:'Não foi possível conferir a alteração.'};}
 await api.vault.write(key,{state:'pending',fingerprint,preview:latest,created:Date.now()});
 try{await api.request(tenant,'agendamentos/'+preview.before.id,preview.kind==='update'?latest.payload:undefined,preview.kind==='update'?'PUT':'DELETE');}
 catch(e){
  if(e.providerStatus&&e.providerStatus<500){const result={state:'rejected',kind:preview.kind,externalId:preview.before.id,message:e.message};await api.vault.write(key,{state:'rejected',fingerprint,preview:latest,result});return result;}
  return {state:'uncertain',kind:preview.kind,externalId:preview.before.id,message:'Resposta não confirmada. Use Verificar resultado antes de tentar outra alteração.'};
 }
 try{return await changeReconcile(api,tenant,input);}catch{return {state:'uncertain',kind:preview.kind,externalId:preview.before.id,message:'Operação enviada. Use Verificar resultado para conferir sem repetir a gravação.'};}
}
