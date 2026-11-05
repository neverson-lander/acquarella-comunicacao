import {createCashbarberChanges} from './cashbarber-changes.mjs';
import {createCashbarberClient} from './cashbarber-client.mjs';
import {bookingInput,externalId,cashError,appointmentPeriod} from './cashbarber-domain.mjs';
import {canReplyAttendance} from './attendance-policy.mjs';
import {ensureConversationCrm} from './crm-conversation.mjs';
import {selectedTouch,realOpportunity,attendanceStart} from '../public/crm-domain.mjs';
import {createCampaignChecks} from './campaign-checks.mjs';
import {createCashbarberContacts} from './cashbarber-contacts.mjs';
import {campaignAnalysis} from '../public/campaign-analysis.mjs';

export function createCashbarber({pool,getConversation,audit,getCrmState,client=createCashbarberClient()}){
  const campaignChecks=createCampaignChecks({pool,getCrmState,getConversation,client});
  const changes=createCashbarberChanges({pool,client,audit});
  const customerDirectory=createCashbarberContacts({pool,client,audit});
  const query=async(sql,args=[])=>(await pool.query(sql,args)).rows;
  async function saveResult(user,cid,bid,result){
    const db=await pool.connect();try{
      await db.query('begin');
      const c=(await db.query('select * from conversations where id=$1 and tenant=$2 for update',[cid,user.tenant])).rows[0];
      await db.query('update cashbarber_bookings set state=$4,receipt=$5,updated=$6 where id=$1 and tenant=$2 and conversation=$3',[bid,user.tenant,cid,result.state,JSON.stringify(result),Date.now()]);
      if(result.state==='confirmed'){
        const account=(await db.query('select * from accounts where id=$1 and tenant=$2',[c.account,user.tenant])).rows[0];
        const first=(await db.query("select min(created) as created from messages where conversation=$1 and direction='in'",[cid])).rows[0].created;
        await ensureConversationCrm(db,c,account,first??c.updated);
      }
      await db.query('commit');
    }catch(e){await db.query('rollback');throw e;}finally{db.release();}
  }
  async function route(user,path,input){
    const action=path.slice('/api/cashbarber/'.length);
    if(action==='import-contacts')return customerDirectory.importPage(user,input);
    if(action==='campaign-bulk-candidates')return campaignChecks.candidates(user,input);
    if(action==='campaign-bulk-check')return campaignChecks.check(user,input);
    if(['status','login','disconnect'].includes(action)){
      if(action==='status'&&!client.configured())return {configured:false,connected:false};
      if(action==='login'){
        if(typeof input.email!=='string'||input.email.length>200||typeof input.password!=='string'||!input.password||input.password.length>200)throw cashError('Informe o e-mail e a senha do CashBarber.');
        const branchId=input.branchId?externalId(input.branchId):undefined;
        if(input.remember!==undefined&&typeof input.remember!=='boolean')throw cashError('Preferência de conexão inválida.');
        const result=await client.call(user.tenant,'login',{email:input.email,password:input.password,...(branchId?{branchId}:{})});await audit(user.tenant,`Conexão CashBarber realizada por ${user.name}.`);return result;
      }
      if(action==='disconnect')await audit(user.tenant,`Desconexão CashBarber solicitada por ${user.name}.`);
      return {configured:true,...await client.call(user.tenant,action,{refresh:input.refresh===true})};
    }
    const c=await getConversation(user,String(input.conversation||''));
    const writable=async()=>{
      if(!canReplyAttendance(user,c))throw cashError('Assuma ou reabra o atendimento para agendar ou vincular o cliente.',403);
      const [account]=await query('select a.enabled,a.deleted_at from accounts a join conversations c on c.account=a.id where c.id=$1 and c.tenant=$2',[c.id,user.tenant]);
      if(!account||account.enabled===false||account.deleted_at)throw cashError('Canal desativado ou excluído. Agendamento indisponível neste atendimento.',409);
    };
    if(['appointment','change-preview','change-commit','change-reconcile'].includes(action)){await writable();return changes.route(user,c,action,input);}
    if(action==='closure'){
      const [first]=await query("select min(m.created) as created from messages m where m.conversation=$1 and m.direction='in' and m.attendance_relevant and m.created>coalesce((select max(h.created) from attendance_history h where h.conversation=$1 and h.action in ('Atendimento finalizado','Atendimento encerrado em massa sem início','Interação encerrada sem atendimento')),0)",[c.id]);
      const attendance_date=new Date(Number(first?.created??c.assigned_at??c.updated)).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
      return {attendance_date,link:(await query('select client_id,client_name from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]))[0]||null,bookings:await query("select id,quote,receipt,confirmed_at from cashbarber_bookings where tenant=$1 and conversation=$2 and state='confirmed' and closure_id is null order by created,id",[user.tenant,c.id])};
    }
    if(action==='context')return {confirmationBookings:await query("select b.id,b.state,b.quote,b.receipt,b.closure_id from cashbarber_bookings b join cashbarber_links l on l.tenant=b.tenant and l.conversation=b.conversation and l.client_id=b.quote->>'clientId' where b.tenant=$1 and b.conversation=$2 and b.state='confirmed' and b.closure_id is null order by b.quote->>'date',b.quote->>'start',b.created,b.id",[user.tenant,c.id]),changes:await query("select id,kind,state,external_id,preview,result,created from cashbarber_changes where tenant=$1 and conversation=$2 and state<>'preview' order by created desc limit 15",[user.tenant,c.id]),link:(await query('select client_id,client_name from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]))[0]||null,bookings:await query('select id,state,quote,receipt,created from cashbarber_bookings where tenant=$1 and conversation=$2 order by created desc limit 15',[user.tenant,c.id])};
    if(action==='clients'){
      const search=String(input.search||'').trim();if(search.length<3||search.length>100)throw cashError('Digite ao menos três caracteres para buscar o cliente.');
      return client.call(user.tenant,'clients',{search});
    }
    if(action==='client')return client.call(user.tenant,'client',{id:externalId(input.id)});
    if(action==='create-client'){
      await writable();
      if(!/^[a-f0-9-]{36}$/i.test(input.operation||''))throw cashError('Operação de cadastro inválida.');
      const result=await client.call(user.tenant,'create-client',{operation:input.operation,name:input.name,phone:input.phone,email:input.email,password:input.password,birthDate:input.birthDate,source:input.source,referredBy:input.referredBy});
      if(result.state!=='confirmed'||!result.client?.id)throw cashError('Cadastro ainda não confirmado no CashBarber.',409);
      await customerDirectory.saveCustomers(user,c.account,[result.client]);
      await audit(user.tenant,`Cliente CashBarber ${result.client.id} cadastrado pela central por ${user.name}, atendimento ${c.id}.`);
      return result;
    }
    if(action==='campaign-bookings'){
      if(input.attendance_id!==undefined){
        if(typeof input.attendance_id!=='string'||input.attendance_id.length>100)throw cashError('Atendimento inválido.');
        const state=await getCrmState(user),cycle=campaignAnalysis(state).direct.find(r=>r.id===input.attendance_id&&r.conversation===c.id);
        if(!cycle||cycle.source!=='paid'||!cycle.ad_id)throw cashError('Atendimento de campanha não encontrado.',404);
        const since=cycle.campaign_contact,until=Math.min(Date.now(),cycle.until===Infinity?Date.now():cycle.until-1);
        const [link]=await query('select client_id from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]);
        const result=await client.call(user.tenant,'campaign-bookings',{client_id:externalId(input.client_id||link?.client_id),from:String(input.from||''),to:String(input.to||''),since,until});
        return campaignChecks.save(user,c.id,{...result,ad_id:cycle.ad_id,reference:'campaign_contact'});
      }
      const [o]=await query('select o.*,a.mode,c.customer,c.attendance_eligible from crm_opportunities o join conversations c on c.id=o.conversation join accounts a on a.id=c.account where o.tenant=$1 and o.conversation=$2',[user.tenant,c.id]);
      if(!o||!realOpportunity(o))throw cashError('Atendimento de campanha não encontrado.',404);
      const touches=await query('select * from crm_touches where tenant=$1 and opportunity=$2 order by created,id',[user.tenant,o.id]),touch=selectedTouch({touches});
      if(touch.source!=='paid'||!touch.ad_id||!Number.isSafeInteger(Number(touch.created)))throw cashError('Este atendimento não possui referência de campanha confirmada.');
      const [link]=await query('select client_id from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]);
      const since=Number(touch.evidence==='webhook'?touch.created:attendanceStart(touches)||o.first_contact);
      if(!Number.isSafeInteger(since)||since<=0)throw cashError('Data de entrada pela campanha não disponível.');
      const result=await client.call(user.tenant,'campaign-bookings',{client_id:externalId(input.client_id||link?.client_id),from:String(input.from||''),to:String(input.to||''),since,until:Date.now()});
      return campaignChecks.save(user,c.id,{...result,ad_id:touch.ad_id,reference:'campaign_contact'});
    }
    if(action==='upcoming-appointments'){
      const [link]=await query('select client_id from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]);if(!link)throw cashError('Vincule o cliente para consultar os próximos agendamentos.');
      return client.call(user.tenant,'upcoming-appointments',{clientId:link.client_id});
    }
    if(action==='appointments'){
      await writable();
      return client.call(user.tenant,'appointments',{client_id:externalId(input.client_id),...appointmentPeriod(input)});
    }
    if(action==='link'){
      await writable();const {client:customer}=await client.call(user.tenant,'client',{id:externalId(input.id)});
      await pool.query('insert into cashbarber_links(tenant,conversation,client_id,client_name,actor,updated) values($1,$2,$3,$4,$5,$6) on conflict(tenant,conversation) do update set client_id=excluded.client_id,client_name=excluded.client_name,actor=excluded.actor,updated=excluded.updated',[user.tenant,c.id,customer.id,customer.name,user.id,Date.now()]);
      await audit(user.tenant,`Cliente CashBarber ${customer.id} vinculado ao atendimento ${c.id} por ${user.name}.`);return {ok:true};
    }
    if(action==='professionals')return client.call(user.tenant,'professionals',{refresh:input.refresh===true});
    if(action==='services')return client.call(user.tenant,'services',{id:externalId(input.id)});
    if(action==='week-day'){
      const date=String(input.date||''),parsed=Date.parse(date+'T12:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date||Math.abs(parsed-Date.now())>367*86400000)throw cashError('Escolha uma data dentro de um ano.');
      return client.call(user.tenant,'week-day',{date,refresh:input.refresh===true});
    }
    if(action==='preview'){
      await writable();if((await query("select id from cashbarber_changes where tenant=$1 and conversation=$2 and state in ('pending','uncertain') limit 1",[user.tenant,c.id])).length)throw cashError('Verifique a alteração ou exclusão pendente antes de agendar.',409);if((await query("select id from cashbarber_bookings where tenant=$1 and conversation=$2 and state in ('pending','uncertain') limit 1",[user.tenant,c.id])).length)throw cashError('Há uma tentativa sem confirmação. Use Verificar registro e confira a agenda antes de repetir.',409);
      const link=(await query('select client_id from cashbarber_links where tenant=$1 and conversation=$2',[user.tenant,c.id]))[0];if(!link)throw cashError('Vincule o cliente antes de agendar.');
      const details=bookingInput({...input,clientId:link.client_id},{allowElapsedStart:true}),result=await client.call(user.tenant,'preview',details),stamp=Date.now();
      const [saved]=await query("insert into cashbarber_bookings(tenant,conversation,actor,state,quote,created,updated,expires) values($1,$2,$3,'preview',$4,$5,$5,$6) returning id",[user.tenant,c.id,user.id,JSON.stringify(result.quote),stamp,stamp+300000]);return {...result,id:saved.id,expires:stamp+300000};
    }
    if(action==='dismiss'){
      await writable();if(!/^[a-f0-9-]{36}$/i.test(input.id||'')||input.confirmedAbsent!==true)throw cashError('Confirme que conferiu a agenda e que o agendamento não existe.');
      const receipt={state:'rejected',message:`Ausência do registro conferida manualmente por ${user.name}.`};
      const [saved]=await query("update cashbarber_bookings set state='rejected',receipt=$1,updated=$2 where id=$3 and tenant=$4 and conversation=$5 and state in ('pending','uncertain') and updated<$6 returning id",[JSON.stringify(receipt),Date.now(),input.id,user.tenant,c.id,Date.now()-120000]);
      if(!saved)throw cashError('Aguarde dois minutos e confira a tentativa antes de liberar outro agendamento.',409);
      await audit(user.tenant,`Ausência de registro CashBarber ${saved.id} conferida manualmente por ${user.name}, atendimento ${c.id}.`);return receipt;
    }
    if(action==='reconcile'){
      await writable();if(!/^[a-f0-9-]{36}$/i.test(input.id||''))throw cashError('Registro inválido.');
      const [saved]=await query('select * from cashbarber_bookings where id=$1 and tenant=$2 and conversation=$3',[input.id,user.tenant,c.id]);
      if(!saved)throw cashError('Registro não encontrado.',404);if(!['pending','uncertain'].includes(saved.state))return {state:saved.state,receipt:saved.receipt};
      if(saved.updated>Date.now()-120000)throw cashError('Aguarde dois minutos antes de verificar esta tentativa.',409);
      const result=await client.call(user.tenant,'reconcile',{operation:saved.id});
      if(!['confirmed','rejected','uncertain'].includes(result.state))throw cashError('Resposta inválida do conector.',502);
      await saveResult(user,c.id,saved.id,result);
      await audit(user.tenant,`Verificação CashBarber ${saved.id}: ${result.state}, operador ${user.name}.`);return result;
    }
    if(action==='commit'){
      await writable();if(!/^[a-f0-9-]{36}$/i.test(input.id||''))throw cashError('Conferência inválida.');
      const args=[input.id,user.tenant,c.id],stamp=Date.now();
      const db=await pool.connect();let locked;
      try{
        await db.query('begin');
        const current=(await db.query('select * from conversations where id=$1 and tenant=$2 for update',[c.id,user.tenant])).rows[0];
        if(!current||!canReplyAttendance(user,current))throw cashError('O atendimento foi encerrado ou transferido. Atualize a conversa antes de agendar.',409);
        [locked]=(await db.query("update cashbarber_bookings b set state='pending',updated=$4 where id=$1 and tenant=$2 and conversation=$3 and actor=$5 and state='preview' and expires>$4 and exists(select 1 from cashbarber_links l where l.tenant=b.tenant and l.conversation=b.conversation and l.client_id=b.quote->>'clientId') returning *",[...args,stamp,user.id])).rows;
        await db.query('commit');
      }catch(error){await db.query('rollback');throw error;}finally{db.release();}
      if(!locked){const [saved]=await query('select id,state,receipt from cashbarber_bookings where id=$1 and tenant=$2 and conversation=$3',args);if(saved&&saved.state!=='preview')return saved;throw cashError('A conferência expirou ou o cliente foi alterado. Consulte os dados novamente.',409);}
      let result;
      try{result=await client.call(user.tenant,'commit',{quote:locked.quote,operation:locked.id});}
      catch{result={state:'uncertain',message:'Resultado não confirmado. Confira a agenda do CashBarber antes de criar outro agendamento.'};}
      if(!['confirmed','rejected','uncertain'].includes(result.state))result={state:'uncertain',message:'Resultado não confirmado. Confira a agenda.'};
      await saveResult(user,c.id,locked.id,result);
      await audit(user.tenant,`Agendamento CashBarber ${locked.id}: ${result.state}, atendimento ${c.id}, operador ${user.name}.`);return {id:locked.id,...result};
    }
    throw cashError('Operação CashBarber não encontrada.',404);
  }
  return {route:(user,...args)=>client.forUser?createCashbarber({pool,getConversation,audit,getCrmState,client:client.forUser(user)}).route(user,...args):route(user,...args)};
}
