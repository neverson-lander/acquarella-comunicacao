import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createCrm} from '../lib/crm-store.mjs';
import {createCampaignChecks} from '../lib/campaign-checks.mjs';
import {campaignAttendances,campaignAttendancesCsv} from '../public/campaign-attendances.mjs';

test('bulk selection honors all filters and permissions, persists creation and value, protects known and concurrently closed attendances',async()=>{
 const db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);for(const f of r.fields||[])if(f.dataTypeID===20)for(const row of r.rows)if(row[f.name]!==null)row[f.name]=Number(row[f.name]);return {...r,rowCount:r.affectedRows??r.rows.length};},pool={query,connect:async()=>({query,release(){}})};
 try{
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 const tenant=randomUUID(),uid=randomUUID(),wa=randomUUID(),ig=randomUUID(),stamp=Date.now()-86400000;
 await query("insert into tenants values($1,'Company','5534999999999')",[tenant]);await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Admin','admin@test.invalid','none','admin')",[uid,tenant]);
 for(const [id,channel]of [[wa,'whatsapp'],[ig,'instagram']])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,$3,$3,'{}','live')",[id,tenant,channel]);
 const user={tenant,id:uid,name:'Admin',role:'admin'},crm=createCrm({pool,permitted:(u,a)=>u.tenant===a.tenant&&u.role==='admin'}),calls=[];let race=false;
 const client={call:async(t,action,input)=>{assert.equal(t,tenant);assert.equal(action,'campaign-auto-bookings');calls.push(input);if(race)await query("insert into attendance_history(tenant,conversation,actor_name,action,created,scheduling) values($1,$2,'Admin','Atendimento finalizado',$3,$4)",[tenant,rows.race.cid,Date.now(),JSON.stringify({had_scheduling:false,services:[]})]);return {status:'matched',since:input.since,checked_at:Date.now(),matches:[{id:'90',created_at:stamp+1000,services:['Manicure'],service_details:[{id:'1',name:'Manicure',price_cents:4550}],amount_cents:4550,date:'2026-12-01',start:'14:00'}],total_amount_cents:4550};}};
 const checks=createCampaignChecks({pool,client,getCrmState:u=>crm.state(u),getConversation:async(u,cid)=>{const c=(await query('select * from conversations where id=$1 and tenant=$2',[cid,u.tenant])).rows[0];if(!c)throw Object.assign(Error('Forbidden'),{status:403});return c;}}),rows={};
 for(const [name,account,status]of [['wa',wa,'open'],['ig',ig,'resolved'],['known',wa,'resolved'],['outside',wa,'open'],['race',wa,'open']]){
  const cid=randomUUID(),ct=randomUUID(),oid=randomUUID(),phone=name==='wa'?'5534984411948':'55349844119'+String(Object.keys(rows).length).padStart(2,'0');rows[name]={cid,oid};
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,$5,$6,$7,$7)",[cid,tenant,account,account===wa?phone:'instagram-scoped-id',name,status,stamp]);
  await query("insert into crm_contacts(id,tenant,account,name,phone,email,created) values($1,$2,$3,$4,$5,$6,$7)",[ct,tenant,account,name,account===wa?phone:'','maria@example.com',stamp]);
  await query("insert into crm_opportunities(id,tenant,conversation,contact,first_contact,updated) values($1,$2,$3,$4,$5,$5)",[oid,tenant,cid,ct,stamp]);
  await query("insert into crm_touches(tenant,opportunity,event_key,source,evidence,ad_id,created) values($1,$2,$5,'paid','webhook',$3,$4)",[tenant,oid,name==='outside'?'999':'123',stamp,randomUUID()]);
 }
 await query("insert into attendance_history(tenant,conversation,actor_name,action,created,scheduling) values($1,$2,'Admin','Atendimento finalizado',$3,$4)",[tenant,rows.known.cid,stamp+1000,JSON.stringify({had_scheduling:false,services:[]})]);
 const filters={ad:'123'},candidates=await checks.candidates(user,{filters});assert.equal(candidates.items.length,3);assert.equal(candidates.preserved,1);assert.ok(!candidates.items.some(c=>c.conversation===rows.outside.cid));
 const input={filters,from:'2026-10-01',to:'2026-12-31'};
 assert.equal((await checks.check(user,{...input,conversation:rows.known.cid})).status,'skipped');assert.equal(calls.length,0);
 const result=await checks.check(user,{...input,conversation:rows.wa.cid});assert.equal(result.saved,true);assert.equal(result.total_amount_cents,4550);assert.equal(calls[0].phone,'5534984411948');assert.equal(calls[0].email,'');
 const preserved=await checks.save(user,rows.wa.cid,{...result,total_amount_cents:99999});assert.equal(preserved.saved,true);assert.equal(preserved.already_saved,true);assert.equal(preserved.total_amount_cents,4550);
 const readOnly=await checks.save({...user,role:'viewer'},rows.wa.cid,result);assert.equal(readOnly.saved,false);
 assert.equal((await checks.check(user,{...input,conversation:rows.wa.cid})).status,'skipped');assert.equal(calls.length,1);
 await checks.check(user,{...input,conversation:rows.ig.cid});assert.equal(calls[1].phone,'');assert.equal(calls[1].email,'maria@example.com');
 const saved=await crm.state(user),view=campaignAttendances(saved,filters);assert.equal(view.rows.find(r=>r.conversation===rows.wa.cid).outcome,'scheduled');assert.match(campaignAttendancesCsv(view.rows),/45\.50/);assert.equal(saved.campaign_checks.length,2);
 race=true;assert.equal((await checks.check(user,{...input,conversation:rows.race.cid})).status,'skipped');assert.equal((await crm.state(user)).campaign_checks.length,2);
 await assert.rejects(checks.candidates({...user,role:'viewer'},{filters}),e=>e.status===403);
 await assert.rejects(checks.check({...user,tenant:randomUUID()},{...input,conversation:rows.wa.cid}),e=>e.status===403);
 }finally{await db.close();}
});
