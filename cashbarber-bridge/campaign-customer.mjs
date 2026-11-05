import {cashError,externalId} from '../vercel-app/lib/cashbarber-domain.mjs';
import {campaignBookings,consultationRange} from './campaign-bookings.mjs';
import {contactPhoneKey,contactPhoneVariants} from '../vercel-app/public/contact-domain.mjs';
export const phoneKey=contactPhoneKey;
export function phoneSearchTerms(value){
 return contactPhoneVariants(value).map(phone=>{
  const national=/^55\d{10,11}$/.test(phone)?phone.slice(2):phone;
  return /^\d{10,11}$/.test(national)?`(${national.slice(0,2)}) ${national.slice(2,-4)}-${national.slice(-4)}`:national;
 });
}
const emailKey=value=>{const email=String(value||'').trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:'';};
export async function campaignAutoBookings(api,tenant,input){
 const range=consultationRange(input),phone=phoneKey(input.phone),email=input.channel==='instagram'?emailKey(input.email):'';
 const base={...range,since:Number(input.since),until:Number(input.until),checked_at:Date.now(),matches:[],total_amount_cents:null};
 if(!['whatsapp','instagram'].includes(input.channel)||!phone&&!email)return {...base,status:'missing_contact'};
 const terms=[];
 if(phone)for(const value of phoneSearchTerms(input.phone))terms.push({kind:'phone',value});
 if(email)terms.push({kind:'email',value:email});
 const ids=new Set();
 for(const term of terms){
  let list;
  if(term.kind==='email'){
   // The quick search does not search emails. Use the provider's paginated customer list.
   const payload=await api.request(tenant,'clientes/list',{data:null,rows:20,totalRecords:0,first:0,last:0,page:0,loading:true,first_visit:true,globalFilter:term.value});
   if(!Array.isArray(payload?.data?.data)||!Number.isInteger(payload.data.last_page))throw cashError('Resposta da busca por e-mail não reconhecida.',502);
   if(payload.data.last_page>1)return {...base,status:'ambiguous_client'};
   list=payload.data.data;
  }else list=await api.request(tenant,'clientes/simpleList',{termo:term.value});
  if(!Array.isArray(list))throw cashError('Resposta da busca de clientes não reconhecida.',502);if(list.length>20)return {...base,status:'ambiguous_client'};for(const c of list)ids.add(externalId(c.id));
 }
 const matching=[];
 for(const id of ids){const c=await api.request(tenant,'clientes/'+id);if(String(c?.id)!==id)throw cashError('Cadastro do cliente não reconhecido.',502);if(phone&&phoneKey(c.cli_telefone)===phone||email&&emailKey(c.email)===email)matching.push(id);}
 if(matching.length!==1)return {...base,status:matching.length?'ambiguous_client':'client_not_found'};
 return campaignBookings(api,tenant,{...input,client_id:matching[0]});
}
