import {managesAttendance,seesAttendance,worksAttendance} from './attendance-policy.mjs';
import {randomUUID} from 'node:crypto';
import {registeredSource,sourceSnapshot} from './registered-source.mjs';
const fail=(text,status=400)=>{throw Object.assign(Error(text),{status});};
export function createAttendance({pool,permitted,now=Date.now}){
  async function transact(fn){const db=await pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
  async function load(db,user,cid){
    const c=(await db.query('select * from conversations where id=$1 and tenant=$2 for update',[cid,user.tenant])).rows[0];
    if(!c)fail('Atendimento não encontrado.',404);
    const account=(await db.query('select * from accounts where id=$1',[c.account])).rows[0];
    if(!account||!permitted(user,account)||!seesAttendance(user,c))fail('Atendimento indisponível para este usuário.',403);
    return {c,account};
  }
  async function record(db,user,c,action,next,scheduling=null){await db.query('insert into attendance_history(tenant,conversation,actor,actor_name,action,previous_owner,next_owner,created,scheduling) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[user.tenant,c.id,user.id,user.name,action,c.assigned_to,next,now(),scheduling===null?null:JSON.stringify(scheduling)]);}
  async function claim(user,cid){
    if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);
    return transact(async db=>{
      const {c,account}=await load(db,user,cid);if(c.status!=='open')fail('Reabra o atendimento antes de assumir.',409);
      if(c.assigned_to&&c.assigned_to!==user.id)fail('O atendimento já foi assumido por outra pessoa.',409);
      if(!permitted(user,account))fail('Sem acesso ao canal.',403);
      if(!c.assigned_to){await db.query('update conversations set assigned_to=$1,assigned_at=$2 where id=$3',[user.id,now(),c.id]);await db.query('update crm_opportunities set owner=$1 where conversation=$2',[user.id,c.id]);await record(db,user,c,'Atendimento assumido',user.id);}
      return {ok:true};
    });
  }
  async function transfer(user,cid,input){
    if(!managesAttendance(user))fail('Apenas administradores e recepcionistas podem transferir.',403);
    return transact(async db=>{
      const {c,account}=await load(db,user,cid);const target=input.assigned_to||null;
      if(target){if(!/^[0-9a-f-]{36}$/i.test(target))fail('Atendente inválido.');const u=(await db.query('select * from users where id=$1 and tenant=$2',[target,user.tenant])).rows[0];if(!u||u.role==='viewer'||!permitted(u,account))fail('Atendente sem acesso a este canal.',403);}
      if(!target&&c.status==='resolved'&&!input.reopen)fail('Reabra o atendimento para devolvê-lo à fila.');
      const status=input.reopen===true?'open':c.status;
      await db.query('update conversations set assigned_to=$1,assigned_at=$2,status=$3,updated=$2 where id=$4',[target,now(),status,c.id]);
      await db.query('update crm_opportunities set owner=$1,updated=$2 where conversation=$3',[target,now(),c.id]);
      await record(db,user,c,(input.reopen===true?'Reaberto e transferido':'Transferido')+(target?'':' para a fila'),target);return {ok:true};
    });
  }
  async function status(user,cid,status,input={}){
    if(!['open','resolved'].includes(status))fail('Status inválido.');
    return transact(async db=>{
      const {c}=await load(db,user,cid);
      if(!worksAttendance(user,c)||(status==='resolved'&&!c.assigned_to))fail('Assuma o atendimento antes de alterar o status.',403);
      let scheduling=null;
      if(status==='resolved'){
        if(c.status!=='open')fail('Este atendimento já está finalizado.',409);
        if(typeof input.had_scheduling!=='boolean')fail('Informe se houve agendamento de serviços antes de encerrar.');
        const ids=input.scheduled_services??[];
        if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))fail('Seleção de serviços inválida.');
        if(input.had_scheduling&&!ids.length)fail('Selecione pelo menos um serviço agendado.');
        if(!input.had_scheduling&&ids.length)fail('Não selecione serviços quando não houve agendamento.');
        const uniqueIds=[...new Set(ids.map(id=>id.toLowerCase()))];
        const services=uniqueIds.length?(await db.query("select id,name from crm_catalog where tenant=$1 and kind='service' and active and id=any($2::uuid[]) order by name for share",[user.tenant,uniqueIds])).rows:[];
        if(services.length!==uniqueIds.length)fail('Selecione apenas serviços ativos cadastrados nesta empresa.');
        scheduling={had_scheduling:input.had_scheduling,services};
        const aid=await registeredSource(db,user.tenant,input);
        const o=(await db.query('select id from crm_opportunities where conversation=$1 and tenant=$2 for update',[c.id,user.tenant])).rows[0];
        if(!o)fail('Cadastro CRM indisponível. Atualize a conversa antes de encerrar.',409);
        const stamp=now();
        const snapshot=await sourceSnapshot(db,user.tenant,o.id,aid);
        await db.query("insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,referral,created,meta_snapshot) values($1,$2,$3,$4,'manual',$5,$6,$7,$8)",[user.tenant,o.id,randomUUID(),input.source,aid,JSON.stringify({correct_first:true,note:'Origem confirmada no encerramento por '+user.name}),stamp,JSON.stringify(snapshot)]);
        await db.query('insert into crm_history(tenant,opportunity,actor_name,action,created) values($1,$2,$3,$4,$5)',[user.tenant,o.id,user.name,'Origem confirmada no encerramento: '+input.source+(aid?' / anúncio '+aid:''),stamp]);
      }
      await db.query('update conversations set status=$1,updated=$2 where id=$3',[status,now(),c.id]);
      await record(db,user,c,status==='open'?'Atendimento reaberto':'Atendimento finalizado',c.assigned_to,scheduling);return {ok:true};
    });
  }
  return {claim,transfer,status};
}
