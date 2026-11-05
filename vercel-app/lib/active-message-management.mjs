import {cashError} from './cashbarber-domain.mjs';
const states=['pending','sending','sent','failed','uncertain','cancelled','expired'];
export function createActiveMessageManagement({pool,now=Date.now}){
  const query=async(sql,args=[])=>(await pool.query(sql,args)).rows;
  function access(user){if(!['admin','receptionist'].includes(user.role))throw cashError('Seu perfil não permite gerenciar mensagens ativas.',403);}
  function scope(user){access(user);return {args:[user.tenant,user.role==='admin'?null:JSON.stringify(user.accounts||[])],sql:"tenant=$1 and ($2::jsonb is null or account::text in (select jsonb_array_elements_text($2::jsonb)))"};}
  async function record(user,id){const base=scope(user);if(!/^[a-f0-9-]{36}$/i.test(id||''))throw cashError('Mensagem inválida.');const row=(await query(`select * from appointment_notifications where ${base.sql} and id=$3`,[...base.args,id]))[0];if(!row)throw cashError('Mensagem indisponível.',404);return row;}
  async function route(user,input={}){
    const base=scope(user),args=[...base.args];let where=base.sql;
    const add=(sql,value)=>{args.push(value);where+=' and '+sql.replace('?',`$${args.length}`);};
    const closing=['close-expired','close-all-expired'].includes(input.action);
    if(input.action==='cancel'||input.action==='cancel-all'||closing){
      const single=['cancel','close-expired'].includes(input.action);
      if(single&&!/^[a-f0-9-]{36}$/i.test(input.id||''))throw cashError('Mensagem inválida.');
      if(input.action==='cancel-all'&&input.confirm!==true)throw cashError('Confirme o cancelamento de todas as mensagens pendentes.');
      if(input.action==='close-all-expired'&&input.confirm!==true)throw cashError('Confirme o encerramento de todas as mensagens com horário ultrapassado.');
      if(single)add('id=?',input.id);
      args.push(now(),user.id,closing?'Mensagem com horário ultrapassado encerrada pela equipe.':'Envio cancelado pela equipe.',closing?'expired':'pending');
      const changed=await query(`update appointment_notifications set state='cancelled',error=$${args.length-1},updated=$${args.length-3},cancelled_by=$${args.length-2} where ${where} and state=$${args.length} returning id`,args);
      if(single&&!changed.length)throw cashError(closing?'A mensagem não está mais com horário ultrapassado. Atualize a lista.':'A mensagem não está mais pendente. Atualize a lista; envios em andamento não podem ser interrompidos.',409);
      return closing?{closed:changed.length}:{cancelled:changed.length};
    }
    if(input.action&&input.action!=='list')throw cashError('Ação inválida.');
    if(input.state){if(!states.includes(input.state))throw cashError('Situação inválida.');add('state=?',input.state);}
    if(input.kind){if(!['confirmation','reminder','subscription'].includes(input.kind))throw cashError('Tipo inválido.');add('kind=?',input.kind);}
    if(input.professional){if(typeof input.professional!=='string'||input.professional.length>200)throw cashError('Profissional inválida.');add('professional_name=?',input.professional);}
    if(input.search){if(typeof input.search!=='string'||input.search.length>100)throw cashError('Busca muito longa.');args.push('%'+input.search.replace(/[\\%_]/g,'\\$&')+'%');where+=` and (client_name ilike $${args.length} escape '\\' or professional_name ilike $${args.length} escape '\\' or recipient ilike $${args.length} escape '\\')`;}
    for(const [key,operator,offset]of [['from','>=',0],['to','<',86400000]])if(input[key]){
      const value=input[key],stamp=Date.parse(value+'T00:00:00-03:00');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==value)throw cashError('Período inválido.');add('due'+operator+'?',stamp+offset);
    }
    const page=Number(input.page||1);if(!Number.isInteger(page)||page<1||page>100000)throw cashError('Página inválida.');
    const total=Number((await query(`select count(*) as total from appointment_notifications where ${where}`,args))[0].total);
    const items=await query(`select id,account,kind,state,error,due,updated,body,client_name,professional_name,recipient,starts_at,cancelled_by,notice from appointment_notifications where ${where} order by due desc,id desc limit 30 offset $${args.length+1}`,[...args,(page-1)*30]);
    const summary=await query(`select state,count(*)::int as total from appointment_notifications where ${base.sql} group by state`,base.args);
    const professionals=(await query(`select distinct professional_name from appointment_notifications where ${base.sql} and professional_name<>'' order by professional_name`,base.args)).map(r=>r.professional_name);
    return {items,total,page,pageSize:30,summary,professionals};
  }
  return {route,record};
}
