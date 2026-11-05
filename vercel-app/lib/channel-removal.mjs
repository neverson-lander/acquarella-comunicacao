import {randomUUID} from 'node:crypto';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export function createChannelRemoval({pool,permitted,usesQr,disconnect,now=Date.now}){
  async function transaction(fn){const db=await pool.connect();try{await db.query('begin');const value=await fn(db);await db.query('commit');return value;}catch(e){await db.query('rollback');throw e;}finally{db.release();}}
  async function locked(db,user,id,input){
    // Lock accounts in a consistent order, including dependent routing channels.
    const accounts=(await db.query('select * from accounts where tenant=$1 order by id for update',[user.tenant])).rows;
    const account=accounts.find(a=>a.id===id);
    if(!account||!permitted(user,account))fail('Canal não disponível para este usuário.',403);
    if(account.deleted_at)return {account,accounts};
    if(input.name!==account.name)fail('O canal foi alterado. Abra a confirmação novamente.',409);
    const bookings=await db.query("select b.id from cashbarber_bookings b join conversations c on c.id=b.conversation where c.account=$1 and b.tenant=$2 and b.state in ('pending','uncertain') limit 1",[id,user.tenant]);
    if(bookings.rows.length)fail('Confira os agendamentos pendentes deste canal antes de excluir.',409);
    const jobs=(await db.query('select id,state from jobs where tenant=$1 and (account=$2 or alert_source=$2 or conversation in (select id from conversations where account=$2)) order by id for update',[user.tenant,id])).rows;
    if(jobs.some(j=>j.state==='sending'))fail('Há um envio em andamento neste canal. Aguarde sua conclusão antes de excluir.',409);
    return {account,accounts};
  }
  async function remove(user,id,input={}){
    if(user.role!=='admin')fail('Apenas administradores podem excluir canais.',403);
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||input.confirmed!==true)fail('Confirme a exclusão do canal.');
    id=id.toLowerCase();
    // Persist the stop before contacting the gateway. A failed disconnect leaves
    // a visible, disabled channel that an administrator can retry removing.
    const account=await transaction(async db=>{
      const {account}=await locked(db,user,id,input);if(account.deleted_at)return account;
      await db.query('update accounts set enabled=false,forwarding_enabled=false,alerts_enabled=false where id=$1',[id]);
      await db.query("update messages set state='failed' where id in (select message from jobs where tenant=$1 and state='pending' and (account=$2 or alert_source=$2 or conversation in (select id from conversations where account=$2)))",[user.tenant,id]);
      await db.query("update jobs set state='cancelled',error='Exclusão do canal solicitada.' where tenant=$1 and state='pending' and (account=$2 or alert_source=$2 or conversation in (select id from conversations where account=$2))",[user.tenant,id]);
      if(account.enabled!==false)await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,`Canal ${account.name} desativado para exclusão por ${user.name}.`,now()]);
      return account;
    });
    if(account.deleted_at)return {ok:true};
    if(usesQr(account))try{const result=await disconnect(account);if(result?.connected===true)throw Error('WhatsApp ainda conectado.');}catch{fail('O canal foi desativado, mas não foi possível confirmar a desconexão do WhatsApp. Tente excluir novamente.',502);}
    return transaction(async db=>{
      const {account,accounts}=await locked(db,user,id,input);if(account.deleted_at)return {ok:true};
      if(account.enabled)fail('O canal foi reativado durante a operação. Abra a confirmação novamente.',409);
      const stamp=now(),dependents=accounts.filter(a=>a.bridge===id&&!a.deleted_at);
      await db.query('update accounts set bridge=null,forwarding_enabled=false,alerts_enabled=false where tenant=$1 and bridge=$2',[user.tenant,id]);
      const conversations=(await db.query("select id,assigned_to from conversations where account=$1 and tenant=$2 and status='open' order by id for update",[id,user.tenant])).rows;
      for(const c of conversations)await db.query("insert into attendance_history(tenant,conversation,actor,actor_name,action,previous_owner,next_owner,created) values($1,$2,$3,$4,'Canal excluído: atendimento encerrado',$5,$5,$6)",[user.tenant,c.id,user.id,user.name,c.assigned_to,stamp]);
      await db.query("update conversations set status='resolved',updated=$1 where account=$2 and tenant=$3 and status='open'",[stamp,id,user.tenant]);
      // Release the provider identifier; the immutable account ID still links history.
      await db.query("update accounts set deleted_at=$1,enabled=false,external='',bridge=null,forwarding_enabled=false,alerts_enabled=false where id=$2 and tenant=$3",[stamp,id,user.tenant]);
      await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,`Canal ${account.name} excluído por ${user.name}. Histórico preservado.${dependents.length?' Encaminhamentos e alertas desativados em: '+dependents.map(a=>a.name).join(', ')+'.':''}`,stamp]);
      return {ok:true,closed:conversations.length,affected:dependents.length};
    });
  }
  return {remove};
}
