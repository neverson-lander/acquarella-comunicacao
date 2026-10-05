import { randomUUID } from 'node:crypto';
import { STAGES, referralTouch, cents,selectedTouch } from './crm-domain.mjs';
import {seesAttendance,worksAttendance} from './attendance-policy.mjs';
import {registeredSource,sourceSnapshot} from './registered-source.mjs';
import {createMetaAttribution} from './meta-attribution.mjs';

const error=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const str=(v,label,max=200,optional=false)=>{if(typeof v!=='string'||v.length>max||(!optional&&!v.trim()))error(`${label} inválido.`);return v.trim();};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const amount=v=>{try{return cents(v);}catch(e){error(e.message);}};

export function createCrm({pool,permitted,open,seal,now=Date.now,fetcher=fetch}) {
  const attribution=createMetaAttribution({pool,open,now,fetcher});
  async function transaction(fn){const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
  const query=(db,sql,args=[])=>db.query(sql,args);
  const one=async(db,sql,args=[])=>(await query(db,sql,args)).rows[0];
  async function opportunity(db,user,oid,lock=false){
    if(!uuid(oid))error('Oportunidade inválida.');
    const o=await one(db,`select o.* from crm_opportunities o where o.id=$1 and o.tenant=$2 ${lock?'for update':''}`,[oid,user.tenant]);
    if(!o)error('Oportunidade não encontrada.',404);
    const account=await one(db,'select a.* from accounts a join conversations c on c.account=a.id where c.id=$1',[o.conversation]);
    if(!account||!permitted(user,account))error('Acesso à oportunidade não autorizado.',403);
    const c=await one(db,'select * from conversations where id=$1',[o.conversation]);
    if(!worksAttendance(user,c))error('Assuma o atendimento antes de editar o CRM.',403);
    return o;
  }
  async function catalogId(db,tenant,id,kind,keepArchived=false){
    if(!id)return null;if(!uuid(id))error('Cadastro inválido.');
    if(!await one(db,'select id from crm_catalog where id=$1 and tenant=$2 and kind=$3 and (active or $4)',[id,tenant,kind,keepArchived]))error('Cadastro indisponível.');
    return id;
  }
  async function history(db,user,o,action){await query(db,'insert into crm_history(tenant,opportunity,actor_name,action,created) values($1,$2,$3,$4,$5)',[user.tenant,o.id,user.name,action,now()]);}

  async function capture(conversation,account,message){
    const ads=new Set();
    await transaction(async db=>{
      await query(db,'select pg_advisory_xact_lock(hashtextextended($1,0))',[account.id+':'+message.customer]);
      let o=await one(db,'select * from crm_opportunities where conversation=$1',[conversation.id]);
      if(!o){
        const contact=await one(db,'insert into crm_contacts(tenant,name,phone,created) values($1,$2,$3,$4) returning id',[account.tenant,conversation.name,account.channel==='whatsapp'?message.customer:'',message.timestamp]);
        o=await one(db,'insert into crm_opportunities(tenant,conversation,contact,first_contact,updated) values($1,$2,$3,$4,$4) returning *',[account.tenant,conversation.id,contact.id,message.timestamp]);
      }
      await query(db,'update crm_opportunities set first_contact=least(first_contact,$1),updated=greatest(updated,$1) where id=$2',[message.timestamp,o.id]);
      await query(db,'update crm_contacts set name=$1 where id=$2 and not name_manual',[conversation.name,o.contact]);
      const pending=(await query(db,'select * from crm_pending_referrals where account=$1 and customer=$2 order by created',[account.id,message.customer])).rows;
      const refs=[...pending.map(p=>({referral:p.referral,external:p.event_key,timestamp:p.created})),message];
      for(const ref of refs){const touch=referralTouch(ref.referral);
      if(touch){
        await query(db,'insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,referral,created) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(opportunity,event_key) do nothing',[account.tenant,o.id,ref.external,touch.source,touch.evidence,touch.ad_id,JSON.stringify(touch.referral),ref.timestamp]);
        if(touch.ad_id){
          ads.add(touch.ad_id);
          await query(db,'insert into crm_ads(tenant,ad_id,updated) values($1,$2,$3) on conflict do nothing',[account.tenant,touch.ad_id,now()]);
          const ad=await one(db,'select * from crm_ads where tenant=$1 and ad_id=$2',[account.tenant,touch.ad_id]);
          if(ad?.verified){
            const {ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,creative,sync_checked}=ad;
            await query(db,"update crm_touches set meta_snapshot=$1 where opportunity=$2 and event_key=$3 and meta_snapshot='{}'::jsonb",[JSON.stringify({ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,creative,consulted_at:sync_checked,verified:true}),o.id,ref.external]);
          }
          if(ad?.service||ad?.offer)await query(db,"update crm_opportunities set service=coalesce(service,$1),offer=case when offer='' then $2 else offer end where id=$3",[ad.service,ad.offer,o.id]);
        }
      }else if(!await one(db,'select id from crm_touches where opportunity=$1 limit 1',[o.id])){
        await query(db,"insert into crm_touches(tenant,opportunity,event_key,source,evidence,created) values($1,$2,$3,'unknown','webhook',$4) on conflict do nothing",[account.tenant,o.id,message.external,message.timestamp]);
      }
      }
      await query(db,'delete from crm_pending_referrals where account=$1 and customer=$2',[account.id,message.customer]);
    });
    for(const aid of [...ads].slice(0,2))await attribution.syncAd(account.tenant,aid).catch(()=>{});
  }
  async function captureReferral(account,message){
    const touch=referralTouch(message.referral);if(!touch)return;
    const c=await transaction(async db=>{
      await query(db,'select pg_advisory_xact_lock(hashtextextended($1,0))',[account.id+':'+message.customer]);
      await query(db,'insert into crm_pending_referrals(tenant,account,customer,event_key,referral,created) values($1,$2,$3,$4,$5,$6) on conflict do nothing',[account.tenant,account.id,message.customer,message.external,JSON.stringify(touch.referral),message.timestamp]);
      return one(db,'select * from conversations where account=$1 and customer=$2',[account.id,message.customer]);
    });
    if(c)return capture(c,account,message);
  }

  async function state(user){
    const accounts=(await pool.query('select * from accounts where tenant=$1',[user.tenant])).rows.filter(a=>permitted(user,a));
    const allowed=accounts.map(a=>a.id);
    const opportunities=(await pool.query('select o.*,c.account,c.customer,c.name as customer_name,c.username,c.assigned_to,c.status,a.channel,a.mode,u.name as owner_name from crm_opportunities o join conversations c on c.id=o.conversation join accounts a on a.id=c.account left join users u on u.id=o.owner where o.tenant=$1 and c.account=any($2::uuid[]) order by o.updated desc',[user.tenant,allowed])).rows.filter(o=>seesAttendance(user,o));
    const ids=opportunities.map(o=>o.id),contacts=[...new Set(opportunities.map(o=>o.contact))];
    const data={opportunities,stages:STAGES};
    for(const [key,sql,args] of [
      ['contacts','select * from crm_contacts where tenant=$1 and id=any($2::uuid[])',[user.tenant,contacts]],
      ['catalog','select * from crm_catalog where tenant=$1 order by kind,name',[user.tenant]],
      ['touches','select * from crm_touches where tenant=$1 and opportunity=any($2::uuid[]) order by created,id',[user.tenant,ids]],
      ['events','select * from crm_events where tenant=$1 and opportunity=any($2::uuid[]) order by occurred',[user.tenant,ids]],
      ['tags','select t.* from crm_opportunity_tags t join crm_opportunities o on o.id=t.opportunity where o.tenant=$1 and o.id=any($2::uuid[])',[user.tenant,ids]],
      ['history','select * from crm_history where tenant=$1 and opportunity=any($2::uuid[]) order by created desc limit 500',[user.tenant,ids]],
      ['attendance_history','select h.* from attendance_history h join crm_opportunities o on o.conversation=h.conversation where h.tenant=$1 and o.id=any($2::uuid[]) order by h.created,h.id',[user.tenant,ids]],
      ['team',"select id,name,role,accounts from users where tenant=$1 and role<>'viewer' order by name",[user.tenant]],
      ['ads','select * from crm_ads where tenant=$1 and ad_id in (select ad_id from crm_touches where opportunity=any($2::uuid[]))',[user.tenant,ids]]
    ])data[key]=(await pool.query(sql,args)).rows;
    if(user.role!=='viewer')data.ads=(await pool.query('select * from crm_ads where tenant=$1 order by updated desc',[user.tenant])).rows;
    data.marketingConfigured=!!(await pool.query('select tenant from crm_settings where tenant=$1',[user.tenant])).rows[0];
    return data;
  }

  async function route(user,path,input){
    if(user.role==='viewer')error('Seu perfil permite apenas visualizar.',403);
    if(path==='/api/crm/catalog'){
      if(user.role!=='admin')error('Apenas administradores gerenciam cadastros.',403);
      if(!['tag','service'].includes(input.kind))error('Tipo de cadastro inválido.');
      const name=str(input.name,'Nome'),color=input.color||'#25ABBE';if(!/^#[0-9a-f]{6}$/i.test(color))error('Cor inválida.');
      const price=input.kind==='service'?amount(input.price):0,description=str(input.description||'','Descrição',2000,true);
      if(input.id){if(!uuid(input.id))error('Cadastro inválido.');const r=await pool.query('update crm_catalog set name=$1,color=$2,price_cents=$3,description=$4,active=$5 where id=$6 and tenant=$7 and kind=$8 returning id',[name,color,price,description,input.active!==false,input.id,user.tenant,input.kind]);if(!r.rowCount)error('Cadastro não encontrado.',404);}
      else await pool.query('insert into crm_catalog(tenant,kind,name,color,price_cents,description) values($1,$2,$3,$4,$5,$6)',[user.tenant,input.kind,name,color,price,description]);
      return {ok:true};
    }
    if(path==='/api/crm/marketing'){
      if(user.role!=='admin')error('Apenas administradores configuram Marketing.',403);
      await pool.query('insert into crm_settings(tenant,secret) values($1,$2) on conflict(tenant) do update set secret=excluded.secret',[user.tenant,seal({token:str(input.token,'Token',4000),version:'v26.0'})]);return {ok:true};
    }
    if(path==='/api/crm/ads/sync'){
      if(user.role!=='admin')error('Apenas administradores sincronizam anúncios.',403);
      if(!await one(pool,'select tenant from crm_settings where tenant=$1',[user.tenant]))error('Configure a credencial Meta Ads com ads_read e acesso à conta de anúncios.',422);
      return attribution.syncPending(user.tenant);
    }
    if(path==='/api/crm/ads'){
      if(user.role!=='admin')error('Apenas administradores gerenciam anúncios.',403);
      const aid=str(input.ad_id,'ID do anúncio');if(!/^\d{1,40}$/.test(aid))error('Use o ID numérico do anúncio.');
      const service=await catalogId(pool,user.tenant,input.service,'service');
      const fields=['ad_name','adset_id','adset_name','campaign_id','campaign_name','offer'].map(k=>str(input[k]||'',k,200,true));
      for(const i of [1,3])if(fields[i]&&!/^\d{1,40}$/.test(fields[i]))error('Use IDs numéricos da Meta.');
      await pool.query('insert into crm_ads(tenant,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,offer,service,updated) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(tenant,ad_id) do update set ad_name=excluded.ad_name,adset_id=excluded.adset_id,adset_name=excluded.adset_name,campaign_id=excluded.campaign_id,campaign_name=excluded.campaign_name,offer=excluded.offer,service=excluded.service,verified=false,updated=excluded.updated',[user.tenant,aid,...fields,service,now()]);return {ok:true};
    }
    const enrich=path.match(/^\/api\/crm\/ads\/(\d+)\/enrich$/);
    if(enrich){
      if(user.role!=='admin')error('Apenas administradores consultam a Meta.',403);
      if(!await one(pool,'select ad_id from crm_ads where tenant=$1 and ad_id=$2',[user.tenant,enrich[1]]))error('Anúncio não cadastrado nesta empresa.',404);
      const result=await attribution.syncAd(user.tenant,enrich[1],{force:true});
      if(!result.ok)error(result.error,422);return result;
    }
    const match=path.match(/^\/api\/crm\/opportunities\/([^/]+)(?:\/(events|void|contact|source))?$/);
    if(!match)error('Rota CRM não encontrada.',404);
    return transaction(async db=>{
      const o=await opportunity(db,user,match[1],true);
      const action=match[2];
      if(action==='events'){
        const c=await one(db,'select customer from conversations where id=$1',[o.conversation]);
        const a=await one(db,'select a.mode from accounts a join conversations c on c.account=a.id where c.id=$1',[o.conversation]);
        if(c.customer.startsWith('demo-')||a.mode==='demo')error('Conversas demonstrativas não registram conversões reais.');
        if(!uuid(input.id))error('Identificador de evento inválido.');
        if(!['appointment','attendance','sale'].includes(input.kind))error('Conversão inválida.');
        const stamp=Number(input.occurred);if(!Number.isSafeInteger(stamp)||stamp<o.first_contact||stamp>now()+366*86400000)error('Data inválida ou anterior ao primeiro contato.');
        if(input.kind!=='appointment'&&stamp>now()+60000)error('Atendimento e venda realizados não podem ter data futura.');
        const value=input.kind==='sale'?amount(input.amount):0;
        const existing=await one(db,'select * from crm_events where id=$1',[input.id]);
        if(existing){if(existing.opportunity!==o.id||existing.kind!==input.kind||existing.occurred!==stamp||existing.amount_cents!==value)error('Identificador de evento já utilizado.',409);return {ok:true};}
        const touches=(await query(db,'select * from crm_touches where opportunity=$1 order by created,id',[o.id])).rows;
        const attribution={first:selectedTouch({touches}),last_paid:selectedTouch({touches},'last_paid')};
        await query(db,'insert into crm_events(id,tenant,opportunity,kind,occurred,amount_cents,actor,actor_name,note,created,attribution) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[input.id,user.tenant,o.id,input.kind,stamp,value,user.id,user.name,str(input.note||'','Observação',2000,true),now(),JSON.stringify(attribution)]);
        const stage={appointment:'scheduled',attendance:'attended',sale:'won'}[input.kind];
        const rank=STAGES.findIndex(s=>s[0]===o.stage),next=STAGES.findIndex(s=>s[0]===stage);
        await query(db,'update crm_opportunities set stage=$1,updated=$2 where id=$3',[rank<next||o.stage==='lost'?stage:o.stage,now(),o.id]);
        await history(db,user,o,`Conversão registrada: ${input.kind}.`);return {ok:true};
      }
      if(action==='void'){
        if(!uuid(input.id))error('Evento inválido.');
        const reason=str(input.reason,'Motivo do cancelamento',1000);
        const e=await one(db,'update crm_events set voided=true where id=$1 and tenant=$2 and opportunity=$3 and not voided returning id',[input.id,user.tenant,o.id]);
        if(e)await history(db,user,o,`Conversão cancelada (${input.id}): ${reason}`);return {ok:true};
      }
      if(action==='source'){
        if(!['paid','organic','unknown'].includes(input.source))error('Origem inválida.');
        const aid=await registeredSource(db,user.tenant,input,{allowUnknown:true});
        const snapshot=await sourceSnapshot(db,user.tenant,o.id,aid);
        await query(db,"insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,referral,created,meta_snapshot) values($1,$2,$3,$4,'manual',$5,$6,$7,$8)",[user.tenant,o.id,randomUUID(),input.source,aid,JSON.stringify({note:str(input.note,'Evidência da origem',1000),correct_first:input.correct_first===true}),now(),JSON.stringify(snapshot)]);
        await history(db,user,o,'Origem adicional registrada manualmente.');return {ok:true};
      }
      if(action==='contact'){
        if(input.link){
          if(!uuid(input.link))error('Contato inválido.');
          const ct=await one(db,'select id from crm_contacts where id=$1 and tenant=$2',[input.link,user.tenant]);if(!ct)error('Contato não encontrado.',404);
          const linked=(await query(db,'select a.*,c.assigned_to,c.status from crm_opportunities x join conversations c on c.id=x.conversation join accounts a on a.id=c.account where x.contact=any($1::uuid[]) and x.tenant=$2',[[o.contact,input.link],user.tenant])).rows;
          if(!linked.every(a=>permitted(user,a)&&worksAttendance(user,a)))error('Sem acesso a todos os atendimentos deste contato.',403);
          await query(db,'update crm_opportunities set contact=$1,updated=$2 where id=$3',[input.link,now(),o.id]);await history(db,user,o,'Contato vinculado manualmente.');return {ok:true};
        }
        const linked=(await query(db,'select a.*,c.assigned_to,c.status from crm_opportunities x join conversations c on c.id=x.conversation join accounts a on a.id=c.account where x.contact=$1 and x.tenant=$2',[o.contact,user.tenant])).rows;
        if(!linked.every(a=>permitted(user,a)&&worksAttendance(user,a)))error('Sem acesso a todos os atendimentos deste contato.',403);
        const name=str(input.name,'Nome'),phone=str(input.phone||'','Telefone',30,true).replace(/\D/g,''),email=str(input.email||'','E-mail',200,true);
        if(phone&&!/^\d{10,15}$/.test(phone))error('Inclua país e DDD no telefone.');if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))error('E-mail inválido.');
        await query(db,'update crm_contacts set name=$1,phone=$2,email=$3,notes=$4,name_manual=true where id=$5 and tenant=$6',[name,phone,email,str(input.notes||'','Notas',5000,true),o.contact,user.tenant]);
        await history(db,user,o,'Cadastro do contato atualizado.');return {ok:true};
      }
      if(!STAGES.some(s=>s[0]===input.stage))error('Estágio inválido.');
      const owner=o.owner; if(input.owner!==undefined&&(input.owner||null)!==owner)error('Use a transferência de atendimento para alterar o responsável.');
      if(!Array.isArray(input.tags))error('Lista de tags inválida.');
      const service=await catalogId(db,user.tenant,input.service,'service',input.service===o.service),tags=[...new Set(input.tags)];if(tags.length>30)error('Limite de 30 tags.');
      const existingTags=(await query(db,'select tag from crm_opportunity_tags where opportunity=$1',[o.id])).rows.map(t=>t.tag);
      for(const tag of tags)await catalogId(db,user.tenant,tag,'tag',existingTags.includes(tag));
      const next=input.next_action?Number(input.next_action):null;if(next!==null&&(!Number.isSafeInteger(next)||next<0))error('Data de retorno inválida.');
      const loss=str(input.loss_reason||'','Motivo da perda',1000,true);if(input.stage==='lost'&&!loss)error('Informe o motivo da perda.');
      await query(db,'update crm_opportunities set stage=$1,owner=$2,service=$3,offer=$4,notes=$5,loss_reason=$6,next_action=$7,updated=$8 where id=$9',[input.stage,owner,service,str(input.offer||'','Oferta',200,true),str(input.notes||'','Notas',5000,true),loss,next,now(),o.id]);
      await query(db,'delete from crm_opportunity_tags where opportunity=$1',[o.id]);for(const tag of tags)await query(db,'insert into crm_opportunity_tags(opportunity,tag) values($1,$2)',[o.id,tag]);
      await history(db,user,o,`Oportunidade atualizada: ${o.stage} → ${input.stage}.`);return {ok:true};
    });
  }
  async function assignOnReply(conversation,user){await pool.query('update crm_opportunities set owner=c.assigned_to from conversations c where c.id=crm_opportunities.conversation and c.id=$1 and c.tenant=$2',[conversation.id,user.tenant]);}
  return {state,route,capture,captureReferral,assignOnReply};
}
