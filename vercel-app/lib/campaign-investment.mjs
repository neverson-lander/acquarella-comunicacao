import {createHash} from 'node:crypto';
const fail=(message,status=422)=>Object.assign(Error(message),{status});
const dateOf=stamp=>new Date(stamp).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
export function metaMoney(value){
 const match=String(value??'').match(/^(\d{1,12})(?:\.(\d{1,2}))?$/);if(!match)throw fail('A Meta retornou um valor de gasto inválido.');
 const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));if(!Number.isSafeInteger(cents))throw fail('Valor de gasto fora do limite.');return cents;
}
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
export function createCampaignInvestment({pool,open,fetcher=fetch,now=Date.now}){
 const cache=new Map(),running=new Map();
 async function report(user,input={}){
  if(user.role!=='admin')throw fail('Apenas administradores consultam o investimento das campanhas.',403);
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Período inválido.');
  const stamp=now(),today=dateOf(stamp);
  const setting=(await pool.query('select secret from crm_settings where tenant=$1',[user.tenant])).rows[0];
  if(!setting)throw fail('Configure a credencial Meta Ads em CRM → Marketing para consultar os gastos.');
  let from=input.from||'';const to=input.to||today;
  if(!from){const first=(await pool.query("select min(o.first_contact) as first from crm_opportunities o join conversations c on c.id=o.conversation join accounts a on a.id=c.account where o.tenant=$1 and a.mode='live' and c.customer not like 'demo-%'",[user.tenant])).rows[0]?.first;from=first?dateOf(Number(first)):dateOf(stamp-29*86400000);}
  if(!validDate(from)||!validDate(to)||from>to||to>today)throw fail('Selecione um período válido, até a data de hoje.');
  if(Date.parse(to)-Date.parse(from)>1095*86400000)throw fail('Consulte até 36 meses de investimento por vez.');
  const key=JSON.stringify([user.tenant,from,to,createHash('sha256').update(setting.secret).digest('hex')]);
  const cached=cache.get(key);if(cached&&stamp-cached.checked_at<300000)return {...cached,cached:true};
  if(running.has(key))return running.get(key);
  const task=load(user,setting,from,to,stamp);running.set(key,task);
  try{const result=await task;cache.set(key,result);if(cache.size>50)cache.delete(cache.keys().next().value);return result;}finally{running.delete(key);}
 }
 async function load(user,setting,from,to,stamp){
  const secret=open(setting.secret),version=/^v\d+\.0$/.test(secret.version)?secret.version:'v26.0';
  const request=async(path,params={})=>{
   const url=new URL('https://graph.facebook.com/'+version+'/'+path);for(const[k,v]of Object.entries(params))url.searchParams.set(k,String(v));
   let response,data;try{response=await fetcher(url.href,{headers:{Authorization:'Bearer '+secret.token},signal:AbortSignal.timeout(15000),redirect:'error'});data=await response.json();}catch{throw fail('Não foi possível consultar os gastos na Meta. Tente novamente.',502);}
   if(!response.ok||data.error)throw fail('A Meta recusou a consulta de gastos. Confira ads_read, a validade da credencial e o acesso à conta de anúncios.',502);
   return data;
  };
  const ads=(await pool.query("select distinct on (campaign_id) ad_id,campaign_id from crm_ads where tenant=$1 and verified and campaign_id<>'' order by campaign_id,updated desc limit 51",[user.tenant])).rows;
  if(!ads.length)throw fail('Atualize os anúncios identificados em CRM → Marketing antes de consultar o investimento.');
  if(ads.length>50)throw fail('Há mais de 50 campanhas cadastradas. A consulta de contas precisa ser configurada para esse volume.');
  const accounts=new Set(),known=new Set();
  // Only accounts linked to verified ads belonging to this tenant are queried.
  for(let i=0;i<ads.length;i+=4){
   const batch=await Promise.all(ads.slice(i,i+4).map(async ad=>{
    if(!/^\d{1,40}$/.test(ad.ad_id))throw fail('Anúncio cadastrado com identificador inválido.');
    const result=await request(ad.ad_id,{fields:'account_id'});if(!/^\d{1,40}$/.test(String(result.account_id||'')))throw fail('Conta de anúncio não reconhecida.');return {account:String(result.account_id),campaign:ad.campaign_id};
   }));for(const item of batch){accounts.add(item.account);known.add(item.campaign);}
  }
  const campaigns=new Map(),zones=new Set();
  for(const id of accounts){
   const account=await request('act_'+id,{fields:'currency,timezone_name'});
   if(account.currency!=='BRL')throw fail('A conta de anúncios usa outra moeda. A comparação exige valores em BRL.');
   if(account.timezone_name!=='America/Sao_Paulo')throw fail('O fuso da conta de anúncios difere de Brasília. A comparação por período precisa de ajuste.');
   zones.add(account.timezone_name);let after='',pages=0;
   do{
    const result=await request('act_'+id+'/insights',{level:'campaign',fields:'campaign_id,campaign_name,spend,account_currency,date_start,date_stop',time_range:JSON.stringify({since:from,until:to}),limit:100,...(after?{after}:{})});
    if(!Array.isArray(result.data))throw fail('A Meta retornou um relatório de gastos inválido.');
    for(const row of result.data){
     if(!/^\d{1,40}$/.test(String(row.campaign_id||''))||row.account_currency!=='BRL')throw fail('Campanha ou moeda não reconhecida no relatório da Meta.');
     const campaign={id:String(row.campaign_id),name:String(row.campaign_name||row.campaign_id).slice(0,300),spend_cents:metaMoney(row.spend)};
     if(campaigns.has(campaign.id))throw fail('A Meta repetiu uma campanha no relatório; consulta interrompida para evitar somar gastos em duplicidade.');
     campaigns.set(campaign.id,campaign);
    }
    after=result.paging?.next?result.paging?.cursors?.after||'':'';if(result.paging?.next&&!after)throw fail('Não foi possível completar a paginação dos gastos.');
    if(++pages>=20&&after)throw fail('O relatório ultrapassou o limite de páginas. Reduza o período.');
   }while(after);
  }
  return {from,to,checked_at:stamp,currency:'BRL',timezone:[...zones].join(', '),campaigns:[...campaigns.values()],known_campaign_ids:[...known],accounts:accounts.size,cached:false};
 }
 return {report};
}
