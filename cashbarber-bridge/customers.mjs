import {journalTenant} from './session-scope.mjs';
import {createHash} from 'node:crypto';
import {cashError,externalId} from '../vercel-app/lib/cashbarber-domain.mjs';
import {phoneKey,phoneSearchTerms} from './campaign-customer.mjs';

export const customerSources=['Cortesia','Eventos','Facebook','Fachada da loja','Google','Indicação','Instagram','Panfleto','Site'];
const emailKey=v=>String(v||'').trim().toLowerCase();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function customerInput(input){
 const name=typeof input.name==='string'?input.name.trim():'',email=emailKey(input.email),phone=String(input.phone||'').replace(/\D/g,'').replace(/^55(?=\d{10,11}$)/,'');
 if(!name||name.length>200)throw cashError('Informe o nome completo, até 200 caracteres.');
 if(!/^[1-9]\d\d{8,9}$/.test(phone))throw cashError('Informe um telefone brasileiro com DDD.');
 if(email.length>200||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))throw cashError('Informe o e-mail do cliente exigido pelo CashBarber.');
 if(typeof input.password!=='string'||input.password.length<6||input.password.length>200)throw cashError('Informe uma senha provisória de 6 a 200 caracteres para o cliente no CashBarber.');
 const birthDate=String(input.birthDate||''),today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}),parsed=Date.parse(birthDate+'T12:00:00Z');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==birthDate||birthDate>=today||birthDate<'1900-01-01')throw cashError('Informe uma data de nascimento válida, anterior a hoje.');
 if(!customerSources.includes(input.source))throw cashError('Informe como o cliente conheceu a empresa.');
 const referredBy=typeof input.referredBy==='string'?input.referredBy.trim():'';
 if(referredBy.length>200)throw cashError('Indicação deve ter até 200 caracteres.');
 return {name,email,phone,birthDate,source:input.source,referredBy,password:input.password};
}
export function safeCustomer(raw){
 return {id:externalId(raw.id),name:typeof raw.cli_name==='string'?raw.cli_name.trim():'',phone:String(raw.cli_telefone||''),email:String(raw.email||'').trim(),active:![0,'0',false].includes(raw.cli_active)};
}
export async function customerPage(api,tenant,input={}){
 const page=input.page??0;if(!Number.isInteger(page)||page<0||page>999)throw cashError('Página de clientes inválida.');
 const payload=await api.request(tenant,'clientes/list',{data:null,rows:100,totalRecords:0,first:page*100,last:0,page,loading:true,first_visit:page===0,globalFilter:input.search||null});
 const data=payload?.data;
 if(!Array.isArray(data?.data)||!Number.isInteger(data.last_page)||data.last_page<1||data.last_page>1000||!Number.isInteger(data.total)||data.total<0||data.current_page!==page+1||data.data.length>100)throw cashError('Paginação de clientes CashBarber não reconhecida.',502);
 return {clients:data.data.map(safeCustomer),page,lastPage:data.last_page,total:data.total};
}
async function findCustomers(api,tenant,details){
 const matches=new Map(),phone=details.phone;
 // The provider's list searches email; the quick autocomplete does not.
 const terms=[...phoneSearchTerms(phone),details.email];
 for(const search of terms){
  let page=0;for(;;){const batch=await customerPage(api,tenant,{page,search});
   for(const c of batch.clients)if(phoneKey(c.phone)===phoneKey(phone)||emailKey(c.email)===details.email)matches.set(c.id,c);
   if(++page>=batch.lastPage)break;if(page>=10)throw cashError('Busca de duplicidades muito ampla. Confira o cadastro no CashBarber.',409);
  }
 }
 return [...matches.values()];
}
export async function createCustomer(api,tenant,input){
 if(!/^[a-f0-9-]{36}$/i.test(input.operation||''))throw cashError('Operação de cadastro inválida.');
 const details=customerInput(input),{password,...identity}=details,key='customer_'+journalTenant(tenant)+'_'+input.operation,identityKey='customer_phone_'+journalTenant(tenant)+'_'+hash(phoneKey(details.phone)).slice(0,32),fingerprint=hash(identity);
 let saved=await api.vault.read(key);
 if(saved&&saved.fingerprint!==fingerprint)throw cashError('Os dados deste cadastro mudaram. Confira a tentativa anterior antes de iniciar outra.',409);
 if(saved?.state==='confirmed')return {state:'confirmed',client:saved.client};
 if(saved?.state==='rejected')throw cashError('A tentativa anterior foi recusada. Confira os dados e inicie um novo cadastro.',422);
 const pending=await api.vault.read(identityKey);
 if(pending&&pending.operation!==input.operation){
  const prior=await api.vault.read('customer_'+journalTenant(tenant)+'_'+pending.operation);
  if(prior?.state==='confirmed'){
   if(prior.fingerprint===fingerprint)return {state:'confirmed',client:prior.client};
   throw cashError('Já existe cliente cadastrado pela central com este telefone. Busque e confira o cadastro existente.',409);
  }
  if(prior?.state!=='confirmed'&&prior?.state!=='rejected'){
   if(prior?.fingerprint===fingerprint)return createCustomer(api,tenant,{...input,operation:pending.operation});
   throw cashError('Já existe cadastro em verificação para este telefone. Verifique a tentativa anterior antes de repetir.',409);
  }
 }
 const matching=await findCustomers(api,tenant,details);
 if(saved){
  const exact=matching.filter(c=>phoneKey(c.phone)===phoneKey(details.phone)&&emailKey(c.email)===details.email);
  if(exact.length===1){saved={...saved,state:'confirmed',client:exact[0]};await api.vault.write(key,saved);return {state:'confirmed',client:saved.client};}
  throw cashError('Resultado do cadastro ainda não confirmado. Confira no CashBarber e use Verificar cadastro; a gravação não será repetida.',409);
 }
 if(matching.length)throw cashError('Já existe cliente com este telefone ou e-mail no CashBarber. Busque e confira o cadastro existente.',409);
 saved={state:'pending',fingerprint,created:Date.now()};
 await api.vault.write(identityKey,{operation:input.operation});await api.vault.write(key,saved);
 let response;
 try{response=await api.request(tenant,'clientes',{cli_name:details.name,cli_telefone:formattedPhone(details.phone),email:details.email,password,cli_data_nascimento:details.birthDate,cli_como_conheceu:details.source,cli_quem_indicou:details.referredBy,cli_cpf:''});}
 catch(error){
  if(error.status===422){await api.vault.write(key,{...saved,state:'rejected'});await api.vault.remove(identityKey);throw error;}
  throw cashError('Resultado do cadastro não confirmado. Use Verificar cadastro antes de tentar cadastrar novamente.',409);
 }
 // A successful response must be read back before the operator can link it.
 try{
  const id=response?.id??response?.data?.id;
  const exact=id?[safeCustomer(await api.request(tenant,'clientes/'+externalId(id)))]:await findCustomers(api,tenant,details);
  const matches=exact.filter(c=>phoneKey(c.phone)===phoneKey(details.phone)&&emailKey(c.email)===details.email);
  if(matches.length!==1)throw Error('Unconfirmed customer');
  saved={...saved,state:'confirmed',client:matches[0]};await api.vault.write(key,saved);return {state:'confirmed',client:saved.client};
 }catch{throw cashError('Cadastro enviado, mas ainda sem confirmação. Use Verificar cadastro para consultar novamente.',409);}
}
function formattedPhone(phone){return `(${phone.slice(0,2)}) ${phone.slice(2,-4)}-${phone.slice(-4)}`;}
