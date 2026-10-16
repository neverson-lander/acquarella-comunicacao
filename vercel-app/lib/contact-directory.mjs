import {createHash,randomUUID} from 'node:crypto';
import {normalizeContactPhone,contactPhoneKey,parseContactsCsv} from '../public/contact-domain.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text=(value,label,max,optional=false)=>{if(typeof value!=='string'||value.length>max||(!optional&&!value.trim()))fail(`${label} inválido.`);return value.trim();};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const folded=value=>String(value).trim().toLocaleLowerCase('pt-BR');
const headerKey=value=>folded(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');

export function createContactDirectory({pool,permitted,now=Date.now}){
  const query=(db,sql,args=[])=>db.query(sql,args),one=async(db,sql,args=[])=>(await query(db,sql,args)).rows[0];
  function access(user){if(!['admin','receptionist'].includes(user.role))fail('Somente administradores e recepcionistas podem acessar o cadastro de contatos.',403);}
  function admin(user){access(user);if(user.role!=='admin')fail('Somente administradores podem importar contatos e criar campos.',403);}
  async function transaction(user,callback){const db=await pool.connect();try{await db.query('begin');await db.query("select set_config('app.contact_actor',$1,true)",[JSON.stringify({id:user.id,name:user.name})]);const value=await callback(db);await db.query('commit');return value;}catch(error){await db.query('rollback');throw error;}finally{db.release();}}
  async function channel(db,user,id,allowDisabled=false){if(!uuid(id))fail('Selecione o canal cadastrado.');const a=await one(db,'select * from accounts where id=$1 and tenant=$2',[id,user.tenant]);if(!a||!permitted(user,a))fail('Canal não autorizado.',403);if(a.enabled===false&&!allowDisabled)fail('Ative o canal para cadastrar ou importar contatos.');return a;}
  async function contact(db,user,id,lock=false){if(!uuid(id))fail('Contato inválido.');const c=await one(db,`select * from crm_contacts where id=$1 and tenant=$2 ${lock?'for update':''}`,[id,user.tenant]);if(!c)fail('Contato não encontrado.',404);if(c.account)await channel(db,user,c.account,true);else if(user.role!=='admin')fail('Contato sem canal definido: solicite a um administrador.',403);const linked=(await query(db,'select a.* from crm_opportunities o join conversations c on c.id=o.conversation join accounts a on a.id=c.account where o.contact=$1 and o.tenant=$2',[id,user.tenant])).rows;if(!linked.every(a=>permitted(user,a)))fail('Sem acesso a todos os canais deste contato.',403);return c;}
  async function metadata(db,user){return {accounts:(await query(db,'select * from accounts where tenant=$1 order by name,id',[user.tenant])).rows.filter(a=>permitted(user,a)).map(({id,name,channel,enabled})=>({id,name,channel,enabled})),tags:(await query(db,"select id,name,color,active from crm_catalog where tenant=$1 and kind='tag' order by name,id",[user.tenant])).rows,fields:(await query(db,'select * from crm_contact_fields where tenant=$1 order by created,id',[user.tenant])).rows};}
  async function tagIds(db,user,values,old=[]){if(!Array.isArray(values)||values.length>50||values.some(id=>!uuid(id)))fail('Selecione até 50 tags cadastradas.');const ids=[...new Set(values)];if(ids.length){const valid=(await query(db,"select id from crm_catalog where tenant=$1 and kind='tag' and id=any($2::uuid[]) and (active or id=any($3::uuid[]))",[user.tenant,ids,old])).rows;if(valid.length!==ids.length)fail('Uma das tags não pertence ao cadastro ativo desta empresa.');}return ids;}
  function customValues(input,definitions,old={}){if(input===undefined)return old;if(!input||typeof input!=='object'||Array.isArray(input))fail('Campos personalizados inválidos.');const result={...old};if(Object.keys(input).length>30)fail('Use até 30 campos personalizados.');for(const [key,value]of Object.entries(input)){const f=definitions.find(f=>f.id===key&&f.active);if(!f)fail('Campo personalizado indisponível.');if(value===''||value===null){delete result[key];continue;}if(f.kind==='text')result[key]=text(value,f.name,400,true);else if(f.kind==='number'){if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value)))fail(`Número inválido: ${f.name}.`);result[key]=Number(value);}else if(f.kind==='boolean'){if(typeof value!=='boolean')fail(`Valor inválido: ${f.name}.`);result[key]=value;}else{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(`Data inválida: ${f.name}.`);result[key]=value;}}return result;}
  function values(input,old,definitions){const name=text(input.name??old?.name,'Nome',200),phone=normalizeContactPhone(input.phone??old?.phone),email=text(input.email??old?.email??'','E-mail',200,true),notes=text(input.notes??old?.notes??'','Observações',400,true),excluded=input.campaignExcluded??old?.campaign_excluded??false;
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('E-mail inválido.');if(typeof excluded!=='boolean')fail('Remover de campanhas deve ser Sim ou Não.');return {name,phone,email,notes,excluded,custom:customValues(input.customFields,definitions,old?.custom_fields)};}
  async function tagsFor(db,id){return (await query(db,'select tag from crm_contact_tags where contact=$1 order by tag',[id])).rows.map(r=>r.tag);}
  async function saveRow(db,user,input,{old,tags,account,definitions}){
    const data=values(input,old,definitions),key=contactPhoneKey(data.phone);
    await query(db,'select pg_advisory_xact_lock(hashtextextended($1,0))',[`${user.tenant}:contact:${account.id}:${key}`]);
    const existing=await one(db,'select id from crm_contacts where tenant=$1 and account=$2 and phone_key=$3',[user.tenant,account.id,key]);if(existing&&existing.id!==old?.id)fail('Já existe contato com esse telefone neste canal. Edite o existente ou use a importação.',409);
    const cid=old?.id||randomUUID();
    if(old)await query(db,'update crm_contacts set name=$1,account=$2,phone=$3,phone_key=$4,email=$5,notes=$6,campaign_excluded=$7,custom_fields=$8,name_manual=true where id=$9 and tenant=$10',[data.name,account.id,data.phone,key,data.email,data.notes,data.excluded,JSON.stringify(data.custom),cid,user.tenant]);
    else await query(db,'insert into crm_contacts(id,tenant,name,account,phone,email,notes,campaign_excluded,custom_fields,name_manual,created) values($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)',[cid,user.tenant,data.name,account.id,data.phone,data.email,data.notes,data.excluded,JSON.stringify(data.custom),now()]);
    const previous=old?await tagsFor(db,cid):[];
    for(const tid of previous.filter(id=>!tags.includes(id)))await query(db,'delete from crm_contact_tags where contact=$1 and tag=$2',[cid,tid]);
    for(const tid of tags.filter(id=>!previous.includes(id)))await query(db,'insert into crm_contact_tags(contact,tag) values($1,$2) on conflict do nothing',[cid,tid]);
    return cid;
  }
  async function list(user,params){access(user);const meta=await metadata(pool,user),allowed=meta.accounts.map(a=>a.id),args=[user.tenant,allowed],where=["c.tenant=$1",user.role==='admin'?"(c.account=any($2::uuid[]) or c.account is null)":"c.account=any($2::uuid[])","not exists(select 1 from crm_opportunities o join conversations v on v.id=o.conversation where o.contact=c.id and not(v.account=any($2::uuid[])))"];
    const add=(sql,value)=>{args.push(value);where.push(sql.replace('?',`$${args.length}`));};
    const name=params.get('name')||'';if(name.length>200)fail('Nome de busca muito longo.');if(name)add("c.name ilike ? escape '\\'",'%'+name.replace(/[\\%_]/g,'\\$&')+'%');
    if(params.get('account')){if(!uuid(params.get('account')))fail('Canal inválido.');add('c.account=?',params.get('account'));}
    if(params.get('tag')){if(!uuid(params.get('tag')))fail('Tag inválida.');add('exists(select 1 from crm_contact_tags t where t.contact=c.id and t.tag=?)',params.get('tag'));}
    for(const [key,op,offset]of [['from','>=',0],['to','<',86400000]])if(params.get(key)){const value=params.get(key);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value)))fail('Data de filtro inválida.');add(`c.created${op}?`,Date.parse(value+'T00:00:00-03:00')+offset);}
    if(params.get('campaignExcluded')&&params.get('campaignExcluded')!=='all'){if(!['true','false'].includes(params.get('campaignExcluded')))fail('Filtro de campanhas inválido.');add('c.campaign_excluded=?',params.get('campaignExcluded')==='true');}
    const active=params.get('active')||'true';if(active!=='all'){if(!['true','false'].includes(active))fail('Filtro de status inválido.');add('c.active=?',active==='true');}
    const page=Number(params.get('page')||1);if(!Number.isSafeInteger(page)||page<1||page>100000)fail('Página inválida.');
    const total=Number((await one(pool,`select count(*) as n from crm_contacts c where ${where.join(' and ')}`,args)).n);
    const rows=(await query(pool,`select c.*,coalesce((select jsonb_agg(tag order by tag) from crm_contact_tags where contact=c.id),'[]'::jsonb) as tags from crm_contacts c where ${where.join(' and ')} order by c.created desc,c.id limit 50 offset $${args.length+1}`,[...args,(page-1)*50])).rows;
    return {...meta,contacts:rows,total,page,pageSize:50};
  }
  async function preview(db,user,input,lock=false){
    const a=await channel(db,user,input.account),meta=await metadata(db,user),selected=await tagIds(db,user,input.tags||[]),parsed=parseContactsCsv(input.csv),errors=[],rows=[],seen=new Set();
    const signature={csv:input.csv,account:a.id,tags:[...selected].sort(),fields:meta.fields.map(f=>[f.id,f.name,f.kind,f.active]),catalog:meta.tags.map(t=>[t.id,t.name,t.active]),versions:[]};
    for(const row of parsed){try{
      if(row.account&&row.account!==a.id&&folded(row.account)!==folded(a.name))fail('O canal do arquivo difere do selecionado na importação.');
      const key=contactPhoneKey(normalizeContactPhone(row.phone));if(seen.has(key))fail('Telefone repetido no mesmo arquivo. Mantenha uma linha por contato.');seen.add(key);
      const old=await one(db,`select * from crm_contacts where tenant=$1 and account=$2 and phone_key=$3 ${lock?'for update':''}`,[user.tenant,a.id,key]);if(old)await contact(db,user,old.id);
      const custom={};for(const [name,value]of Object.entries(row.fields)){const f=meta.fields.find(f=>f.active&&folded(f.name)===folded(name));if(!f)fail(`Campo desconhecido: ${name}. Cadastre-o em Campos personalizados.`);if(f.kind==='boolean'){if(!['','sim','nao','não','true','false','1','0'].includes(value.toLowerCase()))fail(`Valor inválido: ${name}. Use Sim ou Não.`);custom[f.id]=value===''?'':['sim','true','1'].includes(value.toLowerCase());}else custom[f.id]=value;}
      const data=values({...row,customFields:custom},old,meta.fields),names=[...new Set(row.tags||[])];if(names.length+selected.length>50)fail('Limite de 50 tags por contato.');
      for(const name of names)text(name,'Tag',200);
      const previous=old?await tagsFor(db,old.id):[];
      const tagNames=names.map(name=>{const matches=meta.tags.filter(t=>folded(t.name)===folded(name));if(matches.length>1)fail(`Há tags com o mesmo nome: ${name}. Corrija o cadastro.`);if(matches[0]&&!matches[0].active&&!previous.includes(matches[0].id))fail(`Tag arquivada: ${name}.`);return {name:matches[0]?.name||name,id:matches[0]?.id};});
      const clearTags=selected.length===0&&names.length===0;
      const finalCount=new Set([...selected,...(clearTags?[]:previous),...tagNames.map(t=>t.id||'new:'+folded(t.name))]).size;if(finalCount>50)fail('O contato resultaria em mais de 50 tags.');
      signature.versions.push([old?.id||null,old?.updated||null,previous]);
      rows.push({line:row.line,old,input:{...row,customFields:custom},data,tagNames,previous,clearTags,name:data.name,phone:data.phone,action:old?'update':'insert'});
    }catch(error){errors.push({line:row.line,message:error.status?error.message:'Linha inválida.'});}}
    return {a,meta,selected,rows,errors,hash:digest(signature),summary:{created:rows.filter(r=>!r.old).length,updated:rows.filter(r=>r.old).length,clearTags:rows.filter(r=>r.clearTags&&r.previous.length).length,newTags:[...new Set(rows.flatMap(r=>r.tagNames.filter(t=>!t.id).map(t=>t.name)))]}};
  }
  async function route(user,path,input,params){access(user);
    if(path==='/api/contacts'&&input===undefined)return list(user,params);
    if(path==='/api/contacts/fields'&&input){admin(user);return transaction(user,async db=>{const name=text(input.name,'Nome do campo',80);if(['Nome','Canal','Telefone','Email','E-mail','Tags','Observações','Remover de campanhas','Data de cadastro'].some(n=>headerKey(n)===headerKey(name)))fail('Esse nome é reservado para um campo padrão.');if(!['text','number','date','boolean'].includes(input.kind))fail('Tipo de campo inválido.');if(Number((await one(db,'select count(*) as n from crm_contact_fields where tenant=$1',[user.tenant])).n)>=30)fail('Limite de 30 campos personalizados por empresa.');const row=await one(db,'insert into crm_contact_fields(tenant,name,kind,created,created_by) values($1,$2,$3,$4,$5) returning id',[user.tenant,name,input.kind,now(),user.id]);return {ok:true,id:row.id};});}
    if(path==='/api/contacts/import/preview'&&input){admin(user);const plan=await transaction(user,db=>preview(db,user,input));return {hash:plan.hash,errors:plan.errors,summary:plan.summary,rows:plan.rows.map(r=>({line:r.line,name:r.name,phone:r.phone,action:r.action,clearTags:r.clearTags,newTags:r.tagNames.map(t=>t.name)}))};}
    if(path==='/api/contacts/import/commit'&&input){admin(user);if(!uuid(input.id)||typeof input.csv!=='string')fail('Importação inválida.');return transaction(user,async db=>{
      await query(db,'select pg_advisory_xact_lock(hashtextextended($1,0))',['contact-import:'+user.tenant]);
      const fingerprint=digest({csv:input.csv,account:input.account,tags:input.tags||[]}),done=await one(db,'select * from crm_contact_imports where id=$1',[input.id]);
      if(done){if(done.tenant!==user.tenant||done.digest!==fingerprint)fail('Identificador de importação já utilizado.',409);return done.result;}
      const plan=await preview(db,user,input,true);if(plan.errors.length)fail('Corrija as linhas com erro antes de importar.');if(plan.hash!==input.hash)fail('Os dados ou as opções mudaram desde a prévia. Gere uma nova prévia.',409);
      for(const row of plan.rows){const tags=row.clearTags?[]:[...plan.selected,...row.previous];for(const item of row.tagNames){let tid=item.id;if(!tid){let tag=await one(db,"select id from crm_catalog where tenant=$1 and kind='tag' and lower(name)=lower($2)",[user.tenant,item.name]);if(!tag)tag=await one(db,"insert into crm_catalog(tenant,kind,name) values($1,'tag',$2) returning id",[user.tenant,item.name]);tid=tag.id;}tags.push(tid);}const current=row.old?await contact(db,user,row.old.id,true):undefined;await saveRow(db,user,row.input,{old:current,tags:[...new Set(tags)],account:plan.a,definitions:plan.meta.fields});}
      const result={ok:true,...plan.summary};await query(db,'insert into crm_contact_imports(id,tenant,actor,actor_name,digest,result,created) values($1,$2,$3,$4,$5,$6,$7)',[input.id,user.tenant,user.id,user.name,fingerprint,JSON.stringify(result),now()]);return result;
    });}
    if(path==='/api/contacts'&&input)return transaction(user,async db=>{const old=input.id?await contact(db,user,input.id,true):undefined,a=await channel(db,user,input.account,!!old&&input.account===old.account),defs=(await metadata(db,user)).fields,previous=old?await tagsFor(db,old.id):[],tags=await tagIds(db,user,input.tags??previous,previous);const id=await saveRow(db,user,input,{old,tags,account:a,definitions:defs});return {ok:true,id};});
    const match=path.match(/^\/api\/contacts\/([a-f0-9-]{36})\/(history|status)$/i);
    if(match){if(match[2]==='history'&&input===undefined){await contact(pool,user,match[1]);return {history:(await query(pool,'select * from crm_contact_history where tenant=$1 and contact=$2 order by created desc,id desc limit 200',[user.tenant,match[1]])).rows};}
      if(match[2]==='status'&&input){if(typeof input.active!=='boolean')fail('Status do contato inválido.');return transaction(user,async db=>{await contact(db,user,match[1],true);await query(db,'update crm_contacts set active=$1 where id=$2 and tenant=$3',[input.active,match[1],user.tenant]);return {ok:true};});}}
    fail('Não encontrado.',404);
  }
  return {route};
}
