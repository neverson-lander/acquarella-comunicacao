import {randomUUID} from 'node:crypto';
import {hydrateInbox} from './inbox-snapshot.mjs';
import {ensureConversationCrm} from './crm-conversation.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value||'');
const encode=(stamp,id)=>Buffer.from(JSON.stringify([String(stamp),id])).toString('base64url');
function cursor(value){
  if(!value)return null;
  if(typeof value!=='string'||value.length>160||!/^[\w-]+$/.test(value))fail('Página inválida.');
  try{const data=JSON.parse(Buffer.from(value,'base64url').toString());if(!Array.isArray(data)||data.length!==2||!/^\d{1,16}$/.test(data[0])||!uuid(data[1]))throw Error();return data;}catch{fail('Página inválida.');}
}
export function createFinalizedAttendances({pool,permitted,usesQr,now=Date.now}){
  const rows=async(sql,args=[])=>(await pool.query(sql,args)).rows;
  async function accounts(user){return (await rows('select * from accounts where tenant=$1',[user.tenant])).filter(a=>permitted(user,a));}
  async function load(user,cid,db=pool,lock=false){
    if(!uuid(cid))fail('Atendimento inválido.');
    const c=(await db.query('select * from conversations where id=$1 and tenant=$2'+(lock?' for update':''),[cid,user.tenant])).rows[0];
    if(!c)fail('Atendimento não encontrado.',404);
    const a=(await db.query('select * from accounts where id=$1 and tenant=$2',[c.account,user.tenant])).rows[0];
    if(!a||!permitted(user,a))fail('Sem acesso a este canal.',403);
    if(c.status!=='resolved')fail('Este atendimento já está aberto. Atualize a pesquisa.',409);
    return {c,a};
  }
  async function search(user,url){
    const q=(url.searchParams.get('q')||'').trim();if(q.length>100)fail('Pesquise usando até 100 caracteres.');
    const after=cursor(url.searchParams.get('cursor')),allowed=await accounts(user);
    if(!allowed.length)return {items:[],nextCursor:null};
    const normalized=q.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(),digits=q.replace(/\D/g,'');
    const args=[user.tenant,allowed.map(a=>a.id)],conditions=["c.tenant=$1","c.status='resolved'","c.account=any($2::uuid[])"];
    if(q){args.push(normalized);let condition=`position($${args.length} in translate(lower(c.name),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'))>0`;
      if(digits&&/^[\d\s+().-]+$/.test(q)){args.push(digits);condition+=` or position($${args.length} in c.customer)>0`;}
      conditions.push('('+condition+')');}
    if(after){args.push(...after);conditions.push(`(c.updated,c.id)<($${args.length-1}::bigint,$${args.length}::uuid)`);}
    const found=await rows(`select c.id,c.account,c.customer,c.name,c.username,c.updated,c.assigned_to,u.name as assignee_name
      from conversations c left join users u on u.id=c.assigned_to and u.tenant=c.tenant
      where ${conditions.join(' and ')} order by c.updated desc,c.id desc limit 31`,args);
    const items=found.slice(0,30),last=items.at(-1);
    return {items,nextCursor:found.length>30?encode(last.updated,last.id):null};
  }
  async function detail(user,cid,url){
    const {c,a}=await load(user,cid),before=cursor(url.searchParams.get('before')),args=[cid];
    if(before)args.push(...before);
    const found=await rows("select * from messages where conversation=$1 and kind<>'reaction'"+(before?' and (created,id)<($2::bigint,$3::uuid)':'')+' order by created desc,id desc limit 51',args);
    const page=found.slice(0,50),last=page.at(-1);
    await hydrateInbox({pool,user,accounts:[a],conversations:[c],usesQr,messageRows:page.reverse()});
    for(const message of c.messages){message.can_delete=false;message.can_react=false;}
    return {conversation:c,nextMessagesCursor:found.length>50?encode(last.created,last.id):null,canReopen:user.role!=='viewer'&&a.enabled!==false&&!a.deleted_at};
  }
  async function reopen(user,cid){
    if(!['admin','receptionist','agent'].includes(user.role))fail('Seu perfil permite apenas visualizar.',403);
    const db=await pool.connect();let c,a;
    try{
      await db.query('begin');({c,a}=await load(user,cid,db,true));
      if(a.enabled===false||a.deleted_at)fail('Ative o canal antes de reabrir o atendimento.',409);
      const stamp=now();
      await ensureConversationCrm(db,c,a,stamp);
      await db.query("update conversations set status='open',assigned_to=$1,assigned_at=$2,updated=$2,attendance_eligible=true where id=$3 and tenant=$4",[user.id,stamp,c.id,user.tenant]);
      await db.query('update crm_opportunities set owner=$1,updated=$2 where conversation=$3 and tenant=$4',[user.id,stamp,c.id,user.tenant]);
      await db.query("insert into attendance_history(tenant,conversation,actor,actor_name,action,previous_owner,next_owner,created) values($1,$2,$3,$4,'Atendimento reaberto',$5,$3,$6)",[user.tenant,c.id,user.id,user.name,c.assigned_to,stamp]);
      await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,'Atendimento reaberto a partir dos finalizados por '+user.name+'.',stamp]);
      c=(await db.query('select * from conversations where id=$1',[c.id])).rows[0];
      await db.query('commit');
    }catch(error){await db.query('rollback');throw error;}finally{db.release();}
    const messages=await rows("select * from messages where conversation=$1 and kind<>'reaction' order by created desc,id desc limit 50",[c.id]);
    await hydrateInbox({pool,user,accounts:[a],conversations:[c],usesQr,messageRows:messages.reverse()});
    const opportunity=(await rows('select * from crm_opportunities where tenant=$1 and conversation=$2',[user.tenant,c.id]))[0];
    const touches=opportunity?await rows('select * from crm_touches where tenant=$1 and opportunity=$2 order by created,id',[user.tenant,opportunity.id]):[];
    const contact=opportunity?(await rows('select * from crm_contacts where id=$1 and tenant=$2',[opportunity.contact,user.tenant]))[0]:null;
    const tags=opportunity?await rows('select * from crm_opportunity_tags where opportunity=$1',[opportunity.id]):[];
    if(opportunity)Object.assign(opportunity,{account:a.id,customer:c.customer,customer_name:c.name,username:c.username,assigned_to:c.assigned_to,status:c.status,attendance_eligible:c.attendance_eligible,channel:a.channel,mode:a.mode,owner_name:user.name});
    return {ok:true,conversation:c,opportunity,touches,contact,tags};
  }
  return {search,detail,reopen};
}
