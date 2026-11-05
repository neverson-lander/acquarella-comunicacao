import {appointment,changePreview,changeCommit,changeReconcile,upcomingAppointments} from './appointment-changes.mjs';
import {CashConnection} from './connection.mjs';
import {cashError,externalId,appointmentPeriod,bookingInput,availableSlots,clock,minutes,sameQuote} from '../vercel-app/lib/cashbarber-domain.mjs';
import {calendarDate} from './calendar.mjs';
import {apiCalendar} from './api-calendar.mjs';
import {campaignBookings} from './campaign-bookings.mjs';
import {campaignAutoBookings,phoneSearchTerms} from './campaign-customer.mjs';
import {customerPage,createCustomer} from './customers.mjs';
import {notificationAgenda,notificationAppointment} from './notifications.mjs';
import {journalTenant} from './session-scope.mjs';
import {subscriptionList,subscriptionCustomer,comandaOptions,comandaPage,closeComanda} from './daily-actions.mjs';

const base='https://api.cashbarber.com.br/api/painel/';
const invalid=()=>cashError('Resposta da API CashBarber não reconhecida. Consulta interrompida.',502);
const cents=value=>{if(value===null||value===''||!['number','string'].includes(typeof value))throw invalid();const n=Number(value);if(!Number.isFinite(n)||n<0)throw invalid();return Math.round(n*100);};
const array=value=>{if(!Array.isArray(value))throw invalid();return value;};
const named=(id,name)=>{if(typeof name!=='string'||!name.trim())throw invalid();return {id:externalId(id),name:name.trim()};};
const operationKey=(tenant,operation)=>{if(!/^[a-f0-9-]{36}$/i.test(operation||''))throw cashError('Operação inválida.');return 'booking_'+journalTenant(tenant)+'_'+operation;};
function storedBranch(storage){
  const entries=storage?.origins?.find(o=>o.origin==='https://painel.cashbarber.com.br')?.localStorage||[];
  try{
    const auth=JSON.parse(entries.find(e=>e.name==='persist:app-auth')?.value||'null');
    const me=typeof auth?.me==='string'?JSON.parse(auth.me):auth?.me;
    const id=me?.identity?.usu_id_filial;
    return /^\d{1,12}$/.test(String(id||''))?externalId(id):null;
  }catch{return null;}
}

// Only authentication uses Playwright. Operational calls never open a page.
export class CashApi extends CashConnection {
  constructor(browser,vault,{fetcher=fetch,branchId=process.env.CASHBARBER_BRANCH_ID}={}){super(browser,vault);this.fetcher=fetcher;this.branchId=branchId;}
  async connect(tenant,input){
    // An explicit account switch must authenticate the supplied user, even if
    // a previous session is still valid. Never silently reuse its identity.
    await this.contexts.get(tenant)?.close();this.contexts.delete(tenant);
    await this.vault.remove('session_'+tenant);await this.vault.remove('api_'+tenant);await this.vault.remove('credentials_'+tenant);this.clear(tenant);
    const page=await super.page(tenant);let captured='';
    const capture=request=>{if(request.url().startsWith(base)){const auth=request.headers().authorization;if(auth?.startsWith('Bearer '))captured=auth.slice(7);}};
    page.on('request',capture);
    try{
      await super.login(tenant,page,input);
      const storage=await page.context().storageState();
      const cookies=await page.context().cookies('https://api.cashbarber.com.br/');
      const token=captured||cookies.find(c=>c.name==='access_token_painel')?.value||storage.origins.flatMap(o=>o.localStorage).map(e=>e.value.replace(/^"|"$/g,'')).find(v=>/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v));
      if(!token)throw cashError('Login concluído, mas o token da API não foi encontrado. Renove a conexão.',422);
      const selected=await page.evaluate(()=>sessionStorage.getItem('id_filial_agendamento'));
      const branchId=input.branchId||this.branchId||selected||storedBranch(storage)||null;
      await this.vault.write('session_'+tenant,storage);
      await this.vault.write('api_'+tenant,{token,cookies,branchId:branchId?externalId(branchId):null});
      await this.contexts.get(tenant)?.close();this.contexts.delete(tenant);
      await this.directory(tenant);
      if(input.remember===true&&tenant.endsWith('_service'))await this.vault.write('credentials_'+tenant,{email:input.email,password:input.password,branchId:branchId?externalId(branchId):null});
      else if(input.remember===false)await this.vault.remove('credentials_'+tenant);
      return {connected:true,status:'connected'};
    }finally{page.off('request',capture);}
  }
  async session(tenant){
    let saved=await this.vault.read('api_'+tenant);
    const storage=!saved?.branchId?await this.vault.read('session_'+tenant):null;
    if(!saved){
      // Existing encrypted browser sessions can migrate without a new login.
      const cookies=(storage?.cookies||[]).filter(c=>(c.domain==='api.cashbarber.com.br'||c.domain==='.cashbarber.com.br')&&(!c.expires||c.expires<0||c.expires>Date.now()/1000));
      const token=cookies.find(c=>c.name==='access_token_painel')?.value;
      if(token){saved={token,cookies,branchId:this.branchId?externalId(this.branchId):null};await this.vault.write('api_'+tenant,saved);}
    }
    if(!saved?.token)throw cashError('Conecte ou renove a sessão CashBarber nas configurações.',409);
    if(!saved.branchId){const branchId=this.branchId||storedBranch(storage);if(branchId){saved.branchId=externalId(branchId);await this.vault.write('api_'+tenant,saved);}}
    return saved;
  }
  async renew(tenant){
    if(!tenant.endsWith('_service'))return false;
    const key='credentials_'+tenant,saved=await this.vault.read(key);
    if(!saved?.email||!saved.password||saved.retryAfter>Date.now()||this.renewing?.has(tenant))return false;
    this.renewing??=new Set();this.renewing.add(tenant);
    try{
      await this.contexts.get(tenant)?.close();this.contexts.delete(tenant);
      await this.vault.remove('session_'+tenant);await this.vault.remove('api_'+tenant);this.clear(tenant);
      await this.connect(tenant,{...saved,remember:true});return true;
    }catch{
      await this.vault.write(key,{...saved,retryAfter:Date.now()+15*60000});return false;
    }finally{this.renewing.delete(tenant);}
  }
  async request(tenant,path,body,method=body===undefined?'GET':'POST',retried=false){
    let session,response;
    try{session=await this.session(tenant);}catch(error){
      if(error.status!==409||retried||!await this.renew(tenant))throw error;
      session=await this.session(tenant);
    }
    const cookie=session.cookies.filter(c=>(!c.expires||c.expires<0||c.expires>Date.now()/1000)&&(!c.path||new URL(base+path).pathname.startsWith(c.path))).map(c=>`${c.name}=${c.value}`).join('; ');
    try{response=await this.fetcher(base+path,{method,headers:{accept:'application/json, text/plain, */*',...(body!==undefined?{'content-type':'application/json;charset=UTF-8'}:{}),authorization:'Bearer '+session.token,cookie,origin:'https://painel.cashbarber.com.br',referer:'https://painel.cashbarber.com.br/','x-context':'painel'},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000),redirect:'error'});}catch{throw cashError('A API CashBarber não respondeu. Atualize a consulta.',503);}
    if([401,403].includes(response.status)){
      this.clear(tenant);
      // Never repeat a write after an authentication error.
      const read=method==='GET'||/^(agendamentos\/list|servicos\/list|usuarios\/simpleListBarbeirosAtivos|clientes\/(simpleList|list|assinaturas|servico\/preco)|comandas\/list|agendamentos\/check)$/.test(path);
      if(read&&!retried&&await this.renew(tenant))return this.request(tenant,path,body,method,true);
      throw cashError('Sessão expirada ou sem permissão no CashBarber. Renove a conexão.',409);
    }
    if(!response.ok)throw Object.assign(cashError('A API CashBarber recusou a operação. Confira os dados e atualize a consulta.',response.status>=500?502:422),{providerStatus:response.status});
    const empty=response.status===204&&['PUT','DELETE'].includes(method);
    if(response.status!==200&&response.status!==201&&!empty)throw invalid();
    // Keep rotated access cookies encrypted, together with their bearer token.
    let changed=false;for(const header of response.headers.getSetCookie?.()||[]){const [pair,...attributes]=header.split(';'),index=pair.indexOf('='),name=pair.slice(0,index).trim(),value=pair.slice(index+1);if(index<1)continue;const next={name,value,domain:'api.cashbarber.com.br',path:'/',expires:-1};for(const attr of attributes){const [key,...rest]=attr.trim().split('=');if(key.toLowerCase()==='path')next.path=rest.join('=');if(key.toLowerCase()==='max-age')next.expires=Date.now()/1000+Number(rest.join('='));if(key.toLowerCase()==='expires')next.expires=Date.parse(rest.join('='))/1000;}session.cookies=session.cookies.filter(c=>c.name!==name);session.cookies.push(next);if(name==='access_token_painel')session.token=value;changed=true;}
    if(changed)await this.vault.write('api_'+tenant,session);
    if(empty)return null;
    const data=await response.json().catch(()=>{throw invalid();});if(data?.errors||data?.error||data?.success===false)throw cashError('O CashBarber não concluiu a operação. Confira os dados no painel.',422);return data;
  }
  async branch(tenant){
    const session=await this.session(tenant);if(session.branchId)return externalId(session.branchId);
    const date=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
    const data=await this.request(tenant,'agendamentos/list',{data_inicio:date+' 00:00:00',data_fim:date+' 23:59:59',incluir_comanda_nao_finalizada:true});
    if(!Array.isArray(data.filiais)||data.filiais.length!==1)throw cashError('Informe o ID da filial ao renovar a conexão CashBarber.',422);
    session.branchId=externalId(data.filiais[0].id);await this.vault.write('api_'+tenant,session);return session.branchId;
  }
  async directory(tenant,refresh=false){
    const key='api-directory',hit=!refresh&&this.cached(tenant,key);if(hit)return hit;
    const branch=await this.branch(tenant);
    const [rawPeople,catalog]=await Promise.all([this.request(tenant,'usuarios/simpleListBarbeirosAtivos',{id_filial:Number(branch)}),this.catalog(tenant)]);
    const active=new Map(catalog.map(s=>[String(s.id),s]));
    const people=array(rawPeople).map(p=>({...named(p.id,p.usu_name),services:array(p.user_servicos).filter(s=>active.has(String(s.uss_id_servico))).map(link=>{
      const s=active.get(String(link.uss_id_servico)),duration=Number(link.uss_duracao_personalizada??s.ser_duracao);
      if(!Number.isInteger(duration)||duration<1||duration>720)throw invalid();
      return {...named(s.id,s.ser_nome),duration,price:cents(link.uss_valor_personalizado??s.ser_valor)};
    })}));
    return this.remember(tenant,key,people,120000);
  }
  async catalog(tenant){
    const all=[];for(let page=0;page<100;page++){
      const payload=await this.request(tenant,'servicos/list',{data:null,rows:'1000',totalRecords:0,first:page*1000,last:0,page:String(page),loading:true,first_visit:page===0,globalFilter:null,mostrar_inativos:0});
      const list=payload?.data;all.push(...array(list?.data).filter(s=>Number(s.ser_active)===1));
      if(!Number.isInteger(list.last_page)||list.last_page<1)throw invalid();if(page+1>=list.last_page)return all;
    }throw cashError('Catálogo excedeu o limite de consulta.',502);
  }
  async day(tenant,date,people){
    const data=await this.request(tenant,'agendamentos/list',{data_inicio:date+' 00:00:00',data_fim:date+' 23:59:59',id_filial:await this.branch(tenant),incluir_comanda_nao_finalizada:true});
    return {data,calendar:apiCalendar(data,date,people)};
  }
  async customer(tenant,id){
    const [raw,history]=await Promise.all([this.request(tenant,'clientes/'+id),this.request(tenant,`clientes/historico-curto/${id}?quantity=3`)]);
    if(String(raw.id)!==id)throw invalid();
    const plan=raw.plano?.pla_nome||raw.cliente_plano?.plano?.pla_nome||array(raw.assinaturas||[]).find(p=>Number(p.ativa)===1)?.plano||'';
    return {...named(raw.id,raw.cli_name),phone:String(raw.cli_telefone||''),plan,history:array(history).map(h=>{
      const time=String(h.age_inicio||'').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/);if(!time)throw invalid();
      return {id:externalId(h.id),professional:String(h.user?.usu_name||''),date:`${time[3]}/${time[2]}/${time[1]} ${time[4]}`,service:array(h.agendamento_servicos).map(s=>s.servico?.ser_nome||'').join(', '),status:String(h.age_status||'')};
    })};
  }
  async appointments(tenant,input){
    const period=appointmentPeriod(input),from=period.from||period.date,to=period.to||period.date,clientId=externalId(input.client_id);
    const customer=await this.customer(tenant,clientId);
    const data=await this.request(tenant,'agendamentos/list',{data_inicio:from+' 00:00:00',data_fim:to+' 23:59:59',id_filial:await this.branch(tenant),incluir_comanda_nao_finalizada:true});
    const people=array(data.barbeiros);
    const appointments=[];
    for(const event of array(data.agendamentos)){
      if(String(event.id_cliente)!==clientId)continue;
      const status=String(event.age_status||event.status||'');
      if(/cancel|exclu|delet/i.test(status)||[0,'0',false].includes(event.age_active))continue;
      const start=String(event.start||'').replace('T',' ').slice(0,16);
      if(!/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(start))throw invalid();
      const date=start.slice(0,10);if(date<from||date>to)continue;
      const professional=named(event.id_barbeiro,people.find(p=>String(p.id)===String(event.id_barbeiro))?.usu_name);
      const services=array(event.agendamento_servicos).map(s=>named(s.ags_id_servico??s.servico?.id,s.servico?.ser_nome));
      if(!services.length)continue;
      appointments.push({id:externalId(event.id),client_id:clientId,client_name:customer.name,professional_id:professional.id,professional:professional.name,date,start:start.slice(11),status,services});
    }
    return {appointments:appointments.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.id.localeCompare(b.id)),...(period.from?{from,to}:{})};
  }
  async quote(tenant,details){
    const people=await this.directory(tenant,true),professional=people.find(p=>p.id===details.professionalId);
    const matches=professional?.services.filter(s=>s.id===details.service)||[];
    if(matches.length!==1)throw cashError('Serviço indisponível para o profissional. Selecione novamente.',422);
    const service=matches[0],customer=await this.customer(tenant,details.clientId);
    const price=cents(await this.request(tenant,'clientes/servico/preco',{cli_id:Number(details.clientId),servico_id:Number(service.id),age_inicio:details.date,usu_id:Number(details.professionalId)}));
    if(minutes(details.start)+service.duration>=1440)throw cashError('Serviço ultrapassa o fim do dia.',422);
    const {data,calendar}=await this.day(tenant,details.date,people),person=calendar.professionals.find(p=>p.id===details.professionalId);
    if(!person||person.error)throw cashError(person?.error||'Agenda não disponível para o profissional.',422);
    const slots=availableSlots({date:details.date,duration:service.duration,work:person.windows});
    const quote={...details,service:service.name,serviceId:service.id,branchId:await this.branch(tenant),clientName:customer.name,professionalName:professional.name,plan:customer.plan,price,duration:service.duration,end:clock(minutes(details.start)+service.duration)};
    return {quote,available:slots.includes(details.start),elapsedStart:Date.parse(details.date+'T'+details.start+':00-03:00')<=Date.now(),slots,checkedAt:Date.now(),events:data.agendamentos};
  }
  payload(quote){return {age_id_cliente:Number(quote.clientId),age_id_user:Number(quote.professionalId),age_inicio:quote.date+' '+quote.start,age_fim:quote.date+' '+quote.end,age_id_filial:Number(quote.branchId),age_tipo:'Agendamento',age_id:null,age_observacao:'',age_sem_preferencia:false,servicos:[Number(quote.serviceId)]};}
  async commitApi(tenant,{quote,operation}){
    const key=operationKey(tenant,operation),saved=await this.vault.read(key);
    if(saved)return saved.state==='pending'?{state:'uncertain',message:'Tentativa já iniciada. Verifique o registro antes de repetir.'}:{state:saved.state,externalId:saved.externalId,message:saved.message};
    let current;
    try{
      current=await this.quote(tenant,bookingInput({...quote,service:quote.serviceId}));
      if(!current.available||!sameQuote(current.quote,quote)||['serviceId','branchId'].some(k=>current.quote[k]!==quote[k]))return {state:'rejected',message:'Horário, serviço ou valor alterado. Consulte novamente.'};
      const check=await this.request(tenant,'agendamentos/check',this.payload(current.quote));
      if(!check||typeof check!=='object'||Array.isArray(check)||!['indisponivel','duplicado','inadimplente','intervalo'].every(k=>Object.hasOwn(check,k)))throw invalid();
      if(check.indisponivel||check.duplicado||check.inadimplente||check.intervalo)return {state:'rejected',message:'O CashBarber informou um conflito ou restrição. Confira o painel antes de agendar.'};
    }catch(error){return {state:'rejected',message:error.status?error.message:'Não foi possível conferir o agendamento.'};}
    const evidence={quote:current.quote,knownIds:current.events.map(e=>String(e.id)),created:Date.now()};
    await this.vault.write(key,{state:'pending',...evidence});
    try{
      await this.request(tenant,'agendamentos',this.payload(current.quote));
      return await this.reconcileApi(tenant,{operation});
    }catch{
      const result={state:'uncertain',message:'Resultado não confirmado. Verifique o registro antes de repetir.'};await this.vault.write(key,{...evidence,...result});return result;
    }
  }
  async reconcileApi(tenant,{operation}){
    const key=operationKey(tenant,operation),saved=await this.vault.read(key);
    if(!saved)return {state:'rejected',message:'O conector não iniciou a gravação desta tentativa.'};
    if(saved.state==='confirmed')return {state:saved.state,externalId:saved.externalId,message:saved.message};
    if(!saved.quote.serviceId)return {state:'uncertain',message:'Tentativa anterior à integração por API. Confira o registro diretamente no CashBarber.'};
    const q=saved.quote,{data}=await this.day(tenant,q.date,await this.directory(tenant));
    const matches=data.agendamentos.filter(e=>!saved.knownIds.includes(String(e.id))&&String(e.id_cliente)===q.clientId&&String(e.id_barbeiro)===q.professionalId&&String(e.start).replace('T',' ').slice(0,16)===q.date+' '+q.start&&String(e.end).replace('T',' ').slice(0,16)===q.date+' '+q.end&&Array.isArray(e.agendamento_servicos)&&e.agendamento_servicos.length===1&&String(e.agendamento_servicos[0].ags_id_servico)===q.serviceId);
    const result=matches.length===1?{state:'confirmed',externalId:externalId(matches[0].id),message:'Agendamento confirmado no CashBarber.'}:{state:'uncertain',message:'Não foi possível confirmar um registro único. Confira a agenda antes de repetir.'};
    await this.vault.write(key,{...saved,...result});return result;
  }
  async perform(tenant,action,input={}){
    const lock=journalTenant(tenant);
    if(this.locks.has(lock))throw cashError('O CashBarber está processando outra consulta. Tente novamente em instantes.',409);
    if(this.locks.size>=3)throw cashError('Conector ocupado. Tente novamente em instantes.',503);
    this.locks.add(lock);
    const ttl={status:15000,professionals:120000,services:120000,clients:15000,client:15000,'upcoming-appointments':30000,'week-day':30000}[action],key=action+':'+JSON.stringify({...input,refresh:undefined});
    try{
      if(['login','disconnect','commit','create-client','change-commit','change-reconcile'].includes(action))this.clear(tenant);
      if(input.refresh)this.clear(tenant);
      if(action==='disconnect'){await this.contexts.get(tenant)?.close();this.contexts.delete(tenant);await this.vault.remove('api_'+tenant);await this.vault.remove('session_'+tenant);await this.vault.remove('credentials_'+tenant);return {connected:false};}
      if(action==='login')return await this.connect(tenant,input);
      if(ttl&&!input.refresh){const hit=this.cached(tenant,key);if(hit)return {...hit,cached:true};}
      let result;
      if(action==='status'){
        try{await this.directory(tenant,!!input.refresh);result={connected:true,status:'connected'};}catch(error){if(error.status!==409)throw error;result={connected:false,status:'disconnected'};}
      }else if(action==='professionals')result={professionals:(await this.directory(tenant)).map(({id,name})=>({id,name}))};
      else if(action==='services'){const p=(await this.directory(tenant)).find(p=>p.id===externalId(input.id));if(!p)throw cashError('Profissional não encontrado.',404);result={professional:{id:p.id,name:p.name},services:p.services};}
      else if(action==='week-day'){const date=calendarDate(input.date);result=(await this.day(tenant,date,await this.directory(tenant))).calendar;}
      else if(action==='clients'){
        if(typeof input.search!=='string'||input.search.trim().length<3||input.search.length>100)throw cashError('Busca inválida.');
        const terms=phoneSearchTerms(input.search),clients=new Map();
        for(const termo of terms.length?terms:[input.search.trim()])for(const c of array(await this.request(tenant,'clientes/simpleList',{termo})))clients.set(externalId(c.id),{...named(c.id,c.cli_name),phone:String(c.cli_telefone||'')});
        result={clients:[...clients.values()]};
      }
      else if(action==='client')result={client:await this.customer(tenant,externalId(input.id))};
      else if(action==='customer-page')result=await customerPage(this,tenant,input);
      else if(action==='create-client')result=await createCustomer(this,tenant,input);
      else if(action==='upcoming-appointments')result=await upcomingAppointments(this,tenant,input);
      else if(action==='appointment')result={appointment:await appointment(this,tenant,input)};
      else if(action==='change-preview')result=await changePreview(this,tenant,input);
      else if(action==='change-commit')result=await changeCommit(this,tenant,input);
      else if(action==='change-reconcile')result=await changeReconcile(this,tenant,input);
      else if(action==='appointments')result=await this.appointments(tenant,input);
      else if(action==='campaign-bookings')result=await campaignBookings(this,tenant,input);
      else if(action==='campaign-auto-bookings')result=await campaignAutoBookings(this,tenant,input);
      else if(action==='daily-subscriptions')result=await subscriptionList(this,tenant,input);
      else if(action==='daily-subscriber')result=await subscriptionCustomer(this,tenant,input);
      else if(action==='daily-comanda-options')result=await comandaOptions(this,tenant);
      else if(action==='daily-comandas')result=await comandaPage(this,tenant,input);
      else if(action==='daily-close-comanda')result=await closeComanda(this,tenant,input);
      else if(action==='notification-agenda')result=await notificationAgenda(this,tenant,input);
      else if(action==='notification-appointment')result=await notificationAppointment(this,tenant,input.id);
      else if(action==='preview'){const {events,...preview}=await this.quote(tenant,bookingInput(input,{allowElapsedStart:true}));result=preview;}
      else if(action==='commit')return await this.commitApi(tenant,input);
      else if(action==='reconcile')return await this.reconcileApi(tenant,input);
      else throw cashError('Operação inválida.',404);
      return ttl?this.remember(tenant,key,result,ttl):result;
    }finally{if(['commit','change-commit','change-reconcile'].includes(action))this.clear(tenant);this.locks.delete(lock);}
  }
}
