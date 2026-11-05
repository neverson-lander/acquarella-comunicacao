import {cashError} from './cashbarber-domain.mjs';
import {campaignAttendances} from '../public/campaign-attendances.mjs';
import {hasSchedulingInformation} from '../public/campaign-reconciliation.mjs';
import {seesAttendance} from './attendance-policy.mjs';

export function createCampaignChecks({pool,getCrmState,getConversation,client}){
 const state=async user=>{if(user.role==='viewer')throw cashError('Seu perfil permite apenas visualizar.',403);if(!getCrmState)throw cashError('Consulta em massa indisponível.',503);return getCrmState(user);};
 async function save(user,conversation,report,db=pool){
  if(user.role==='viewer')return {...report,saved:false};
  const since=Number(report.since)||0;
  await db.query(`insert into cashbarber_campaign_check_history(tenant,conversation,ad_id,since,report,actor,checked_at) values($1,$2,$3,$4,$5,$6,$7)
    on conflict(tenant,conversation,ad_id,since) do update set report=excluded.report,actor=excluded.actor,checked_at=excluded.checked_at
    where cashbarber_campaign_check_history.report->>'status'<>'matched'`,[user.tenant,conversation,report.ad_id,since,JSON.stringify(report),user.id,report.checked_at||Date.now()]);
  const {rows}=await db.query(`insert into cashbarber_campaign_checks(tenant,conversation,ad_id,report,actor,checked_at) values($1,$2,$3,$4,$5,$6)
   on conflict(tenant,conversation,ad_id) do update set report=excluded.report,actor=excluded.actor,checked_at=excluded.checked_at
   where coalesce((excluded.report->>'since')::bigint,0)>=coalesce((cashbarber_campaign_checks.report->>'since')::bigint,0)
   and (cashbarber_campaign_checks.report->>'status'<>'matched' or cashbarber_campaign_checks.report->>'since' is distinct from excluded.report->>'since') returning report`,[user.tenant,conversation,report.ad_id,JSON.stringify(report),user.id,report.checked_at||Date.now()]);
  if(rows[0])return {...rows[0].report,saved:true};
  const previous=(await db.query('select report from cashbarber_campaign_check_history where tenant=$1 and conversation=$2 and ad_id=$3 and since=$4',[user.tenant,conversation,report.ad_id,since])).rows[0]?.report;
  if(!previous)throw cashError('Não foi possível confirmar o salvamento da consulta. Consulte novamente.',409);
  return {...previous,saved:true,already_saved:true};
 }
 async function hasInformation(db,user,conversation){
  const {rows}=await db.query(`with boundary as (select coalesce(max(t.created),0) as since from crm_touches t join crm_opportunities o on o.id=t.opportunity
    where o.tenant=$1 and o.conversation=$2 and not t.ignored_for_attribution and t.referral ? 'attendance_start')
   select exists(select 1 from attendance_history,boundary where tenant=$1 and conversation=$2 and created>=since and scheduling->>'had_scheduling' in ('true','false'))
   or exists(select 1 from cashbarber_bookings,boundary where tenant=$1 and conversation=$2 and state in ('confirmed','pending','uncertain') and (state in ('pending','uncertain') or confirmed_at>=since))
   or exists(select 1 from crm_events e join crm_opportunities o on o.id=e.opportunity cross join boundary where o.tenant=$1 and o.conversation=$2 and e.kind='appointment' and not e.voided and e.occurred>=since)
   or exists(select 1 from cashbarber_campaign_checks,boundary where tenant=$1 and conversation=$2 and report->>'status'='matched' and coalesce((report->>'since')::bigint,0)>=since) as found`,[user.tenant,conversation]);
  return rows[0]?.found===true;
 }
 async function candidates(user,input){
  const crm=await state(user),rows=campaignAttendances(crm,input.filters||{}).rows;
  const items=rows.filter(r=>['whatsapp','instagram'].includes(r.channel)&&!hasSchedulingInformation(crm,r.conversation));
  return {items:items.map(r=>({conversation:r.conversation,client:r.client,channel:r.channel,ad_id:r.ad_id})),preserved:rows.length-items.length};
 }
 async function check(user,input){
  await getConversation(user,String(input.conversation||''));
  const crm=await state(user),row=campaignAttendances(crm,input.filters||{}).rows.find(r=>r.conversation===input.conversation);
  if(!row||hasSchedulingInformation(crm,row.conversation)||await hasInformation(pool,user,row.conversation))return {status:'skipped',matches:[]};
  const opportunity=crm.opportunities.find(o=>o.id===row.id),contact=crm.contacts.find(c=>c.id===opportunity.contact);
  const result=await client.call(user.tenant,'campaign-auto-bookings',{channel:row.channel,phone:row.channel==='whatsapp'?opportunity.customer:contact?.phone||'',email:row.channel==='instagram'?contact?.email||'':'',from:String(input.from||''),to:String(input.to||''),since:row.campaign_contact,until:Date.now()});
  const report={...result,ad_id:row.ad_id,reference:'campaign_contact',automatic:true};
  const db=await pool.connect();try{
   await db.query('begin');
   await db.query('select id from conversations where tenant=$1 and id=$2 for update',[user.tenant,row.conversation]);
   const {rows}=await db.query('select id from crm_opportunities where tenant=$1 and conversation=$2 for update',[user.tenant,row.conversation]);
   if(!rows.length||await hasInformation(db,user,row.conversation)){await db.query('rollback');return {status:'skipped',matches:[]};}
   // Attribution/contact may change while the provider is being consulted.
   const currentOpportunity=(await db.query('select o.*,c.customer,c.name as customer_name,c.status,c.assigned_to,c.account,c.attendance_eligible,a.channel,a.mode from crm_opportunities o join conversations c on c.id=o.conversation join accounts a on a.id=c.account where o.tenant=$1 and o.conversation=$2',[user.tenant,row.conversation])).rows[0];
   if(!currentOpportunity||!seesAttendance(user,currentOpportunity)){await db.query('rollback');return {status:'skipped',matches:[]};}
   const currentContact=(await db.query('select * from crm_contacts where tenant=$1 and id=$2 for update',[user.tenant,currentOpportunity.contact])).rows[0];
   const currentTouches=(await db.query('select * from crm_touches where tenant=$1 and opportunity=$2',[user.tenant,currentOpportunity.id])).rows;
   const fresh={...crm,opportunities:[currentOpportunity],contacts:currentContact?[currentContact]:[],touches:currentTouches};
   const current=campaignAttendances(fresh,input.filters||{}).rows[0];
   if(!current||current.ad_id!==row.ad_id||current.campaign_contact!==row.campaign_contact||current.phone!==row.phone||current.email!==row.email||currentOpportunity.customer!==opportunity.customer||current.account!==row.account||current.channel!==row.channel){await db.query('rollback');return {status:'skipped',matches:[]};}
   const saved=await save(user,row.conversation,report,db);await db.query('commit');return saved;
  }catch(e){await db.query('rollback');throw e;}finally{db.release();}
 }
 return {save,candidates,check};
}
