import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createCrm} from '../lib/crm-store.mjs';
import {createAttendance} from '../lib/attendance-store.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {selectedTouch,automaticPaidTouch} from '../public/crm-domain.mjs';
import {campaignAttendances} from '../public/campaign-attendances.mjs';
import {hasSchedulingInformation} from '../public/campaign-reconciliation.mjs';

test('closed organic → paid → organic → another campaign uses the new attendance and preserves old evidence',async()=>{
 const db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);for(const f of r.fields||[])if(f.dataTypeID===20)for(const row of r.rows)if(row[f.name]!==null)row[f.name]=Number(row[f.name]);return {...r,rowCount:r.affectedRows??r.rows.length};},pool={query,connect:async()=>({query,release(){}})};
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  const tenant=randomUUID(),aid=randomUUID(),uid=randomUUID(),customer='5534999998888',user={id:uid,tenant,role:'admin',name:'Equipe'};let stamp=Date.parse('2026-11-01T12:00:00-03:00');
  await query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[tenant]);
  await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Equipe','source@test.invalid','unused','admin')",[uid,tenant]);
  await query("insert into accounts(id,tenant,name,channel,secret,external,mode) values($1,$2,'WhatsApp','whatsapp','{}','wa','live')",[aid,tenant]);
  const account=(await query('select * from accounts where id=$1',[aid])).rows[0],permitted=()=>true;
  const crm=createCrm({pool,permitted,now:()=>stamp,open:JSON.parse,seal:JSON.stringify}),attendance=createAttendance({pool,permitted,now:()=>stamp});
  const inbound=createInboundHandler({one:async(sql,args)=>(await query(sql,args)).rows[0],run:query,id:randomUUID,now:()=>stamp,open:JSON.parse,profile:async()=>({}),send:async()=>{},queue:async()=>{},audit:async()=>{},capture:crm.capture,captureReferral:crm.captureReferral});
  const send=async(id,referral)=>{stamp+=10000;await inbound(account,{entry:[{changes:[{value:{metadata:{phone_number_id:'wa'},contacts:[{wa_id:customer,profile:{name:'Lucia'}}],messages:[{id,from:customer,timestamp:String(stamp/1000),type:'text',text:{body:'Olá'},...(referral?{referral}:{})}]}}]}]});};
  const current=async()=>{const state=await crm.state(user),opportunity=state.opportunities[0];return {state,opportunity,touches:state.touches.filter(t=>t.opportunity===opportunity.id)};};
  const close=async(source,ad_id)=>{stamp+=10000;const {opportunity}=await current();await attendance.claim(user,opportunity.conversation);await attendance.status(user,opportunity.conversation,'resolved',{source,ad_id,had_scheduling:false});};
  await send('first');await close('organic');
  const before=await current(),oldCorrection=before.touches.find(t=>t.evidence==='manual');assert.ok(oldCorrection);
  await send('paid',{source_type:'ad',source_id:'123'});
  let data=await current();assert.equal(selectedTouch(data).ad_id,'123');assert.equal(automaticPaidTouch(data).ad_id,'123');assert.ok(data.touches.some(t=>t.id===oldCorrection.id));
  assert.equal(hasSchedulingInformation(data.state,data.opportunity.conversation),false,'old closure cannot settle the new campaign attendance');
  const row=campaignAttendances(data.state,{},stamp).rows[0];assert.equal(row.ad_id,'123');assert.equal(row.first_contact,stamp);assert.equal(row.campaign_contact,stamp);
  await send('ordinary-followup');data=await current();assert.equal(selectedTouch(data).ad_id,'123','follow-up while open keeps the active origin');
  await close('paid','123');await send('organic-return');data=await current();assert.equal(selectedTouch(data).source,'organic');assert.equal(automaticPaidTouch(data),null);assert.equal(campaignAttendances(data.state,{},stamp).rows.length,0);
  await close('organic');await send('other-paid',{source_type:'ad',source_id:'456'});data=await current();assert.equal(selectedTouch(data).ad_id,'456');assert.equal(automaticPaidTouch(data).ad_id,'456');
  const markers=data.touches.filter(t=>t.referral?.attendance_start);assert.equal(markers.length,3);const original=data.touches.filter(t=>!t.referral?.attendance_start);
  await query("delete from crm_touches where opportunity=$1 and referral ? 'attendance_start'",[data.opportunity.id]);
  const migration=await readFile(new URL('../supabase/migrations/20261103010000_attendance_source_windows.sql',import.meta.url),'utf8');await db.exec(migration);await db.exec(migration);
  data=await current();assert.equal(data.touches.filter(t=>t.referral?.attendance_start).length,3);assert.equal(selectedTouch(data).ad_id,'456');
  assert.deepEqual(data.touches.filter(t=>!t.referral?.attendance_start),original,'repair preserves every original touch');
  assert.equal((await query('select count(*)::int as total from attendance_history where action=$1',["Atendimento finalizado"])).rows[0].total,3);
 }finally{await db.close();}
});
