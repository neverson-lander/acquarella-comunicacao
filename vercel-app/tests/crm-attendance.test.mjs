import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createCrm} from '../lib/crm-store.mjs';
import {createAttendance} from '../lib/attendance-store.mjs';
import {seesAttendance,worksAttendance,canReplyAttendance} from '../lib/attendance-policy.mjs';
import {referralTouch,cents,selectedTouch,summarize,realOpportunity} from '../lib/crm-domain.mjs';
import {createMetaAttribution,creativeDetails} from '../lib/meta-attribution.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {metaMediaUrl} from '../public/meta-media.js';

const db=new PGlite(),tenant=randomUUID(),otherTenant=randomUUID(),accountId=randomUUID();
const now=()=>1790805000000;
const users={};let crm,attendance;
const permitted=(u,a)=>u.tenant===a.tenant&&(u.role==='admin'||u.accounts.includes(a.id));
async function execute(sql,args=[]){const r=await db.query(sql,args);for(const field of r.fields||[])if(field.dataTypeID===20)for(const row of r.rows)if(row[field.name]!==null)row[field.name]=Number(row[field.name]);return {...r,rowCount:r.affectedRows??r.rows.length};}
let pending=Promise.resolve();
const pool={query:execute,connect:async()=>{const previous=pending;let release;pending=new Promise(resolve=>{release=resolve;});await previous;return{query:execute,release};}};
before(async()=>{
  for(const file of ['202609290001_initial','202609290003_whatsapp_bridge','202609300004_sac','202609300005_crm','202609300006_attendance','202609300007_meta_attribution','202610020008_closure_scheduling','20261016042106_contact_directory_and_channel_activation']){
    const sql=await readFile(new URL('../supabase/migrations/'+file+'.sql',import.meta.url),'utf8');
    await db.exec(sql.replace('create extension if not exists pgcrypto;',''));
  }
  await execute('insert into tenants(id,name,phone) values($1,$2,$3),($4,$5,$3)',[tenant,'Company','5534988748139',otherTenant,'Other']);
  await execute("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Instagram','instagram','{}','live')",[accountId,tenant]);
  for(const role of ['admin','receptionist','agent','agent2','viewer','outsider']){
    const actual=role==='agent2'||role==='outsider'?'agent':role;
    const u={id:randomUUID(),tenant:role==='outsider'?otherTenant:tenant,name:role,role:actual,accounts:[accountId]};users[role]=u;
    await execute('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[u.id,u.tenant,u.name,role+'@test.invalid','unused',actual,JSON.stringify(u.accounts)]);
  }
  crm=createCrm({pool,permitted,now,open:JSON.parse,seal:JSON.stringify,fetcher:async()=>new Response(JSON.stringify({id:'123',name:'Ad',campaign:{id:'456',name:'Campaign'},adset:{id:'789',name:'Set'}}))});
  attendance=createAttendance({pool,permitted,now});
});
after(async()=>db.close());
async function fixture(referral){
  const cid=randomUUID(),customer=randomUUID(),message={external:randomUUID(),customer,body:'Hello',timestamp:now()-10000,referral};
  await execute("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,'Maria','open',$5,$5)",[cid,tenant,accountId,customer,message.timestamp]);
  const conversation=(await execute('select * from conversations where id=$1',[cid])).rows[0];
  const account=(await execute('select * from accounts where id=$1',[accountId])).rows[0];
  await crm.capture(conversation,account,message);
  const o=(await execute('select * from crm_opportunities where conversation=$1',[cid])).rows[0];
  return {cid,o,conversation,account,message};
}
const dealInput=o=>({stage:o.stage,owner:o.owner,service:o.service,offer:o.offer,notes:o.notes,loss_reason:o.loss_reason,tags:[]});

test('money is stored as integer cents and malformed values are rejected',()=>{
  assert.equal(cents('129,90'),12990);assert.equal(cents('0'),0);
  for(const value of ['-1','1.001','1e3','Infinity',''])assert.throws(()=>cents(value));
});
test('attribution preserves ad evidence without guessing organic or service',()=>{
  assert.equal(referralTouch(undefined),null);
  assert.equal(referralTouch({source_type:'ad',source_id:'123',ctwa_clid:'click'}).ad_id,'123');
  assert.equal(referralTouch({source_type:'post',source_id:'321'}).source,'organic');
  assert.equal(referralTouch({ref:'arbitrary'}).source,'unknown');
  assert.equal(referralTouch({source:'ADS',ad_id:'456'}).source,'paid');
});
test('first touch, latest paid and manual correction remain separate',()=>{
  const o={touches:[{id:'a',created:1,source:'organic',evidence:'webhook'},{id:'b',created:2,source:'paid',ad_id:'ad',evidence:'webhook'}]};
  assert.equal(selectedTouch(o).source,'organic');assert.equal(selectedTouch(o,'last_paid').ad_id,'ad');
  o.touches.push({id:'c',created:3,source:'unknown',evidence:'manual',referral:{correct_first:true}});
  assert.equal(selectedTouch(o).source,'unknown');assert.equal(selectedTouch(o,'last_paid').source,'paid');
});
test('agent visibility includes only queue and own open/closed attendances',()=>{
  const u={id:'u',tenant:'t',role:'agent'},queue={tenant:'t',status:'open',assigned_to:null};
  assert.equal(seesAttendance(u,queue),true);assert.equal(worksAttendance(u,queue),false);
  assert.equal(seesAttendance(u,{...queue,status:'resolved'}),false);
  assert.equal(seesAttendance(u,{...queue,assigned_to:'v'}),false);
  assert.equal(seesAttendance(u,{...queue,assigned_to:'u',status:'resolved'}),true);
  assert.equal(seesAttendance({...u,role:'receptionist'},{...queue,assigned_to:'v'}),true);
  assert.equal(seesAttendance({...u,role:'admin'},{...queue,tenant:'other'}),false);
});
test('queue replies are blocked for every role until explicitly claimed and closed cases require reopening',()=>{
  const queue={tenant,status:'open',assigned_to:null};
  for(const role of ['admin','receptionist','agent','viewer'])assert.equal(canReplyAttendance(users[role],queue),false);
  const own={...queue,assigned_to:users.agent.id};
  assert.equal(canReplyAttendance(users.agent,own),true);
  assert.equal(canReplyAttendance(users.agent,{...own,status:'resolved'}),false);
  assert.equal(canReplyAttendance(users.agent2,own),false);
});
test('new contacts enter the unassigned queue and cannot be closed by an administrator before claim',async()=>{
  const f=await fixture();
  assert.equal(f.conversation.assigned_to,null);assert.equal(f.o.owner,null);
  assert.equal(seesAttendance(users.agent,f.conversation),true);
  await assert.rejects(attendance.status(users.admin,f.cid,'resolved',{had_scheduling:false,source:'organic'}),e=>e.status===403);
});
test('closing requires an explicit origin and paid leads require a previously registered same-tenant ad',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  const baseline=(await execute('select count(*) as n from crm_touches where opportunity=$1',[f.o.id])).rows[0].n;
  for(const input of [{},{source:'unknown'},{source:'paid'},{source:'paid',ad_id:'999991'},{source:'organic',ad_id:'123'}]){
    await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,...input}),e=>e.status===400);
    assert.equal((await execute('select status from conversations where id=$1',[f.cid])).rows[0].status,'open');
  }
  await execute('insert into crm_ads(tenant,ad_id,updated) values($1,$2,$3)',[otherTenant,'999991',now()]);
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'paid',ad_id:'999991'}),e=>e.status===400);
  assert.equal((await execute('select count(*) as n from crm_touches where opportunity=$1',[f.o.id])).rows[0].n,baseline);
  await crm.route(users.admin,'/api/crm/ads',{ad_id:'888881',ad_name:'Registered campaign'});
  assert.ok((await crm.state(users.agent)).ads.some(a=>a.ad_id==='888881'));
  await attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'paid',ad_id:'888881'});
  const touches=(await execute('select * from crm_touches where opportunity=$1',[f.o.id])).rows;
  assert.equal(selectedTouch({touches}).ad_id,'888881');
  assert.equal((await execute('select status from conversations where id=$1',[f.cid])).rows[0].status,'resolved');
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'organic'}),e=>e.status===409);
  await attendance.status(users.agent,f.cid,'open');
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved'),e=>e.status===400);
  await attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'organic'});
});
test('manual CRM paid attribution also rejects unregistered ads instead of silently creating them',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  await assert.rejects(crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/source',{source:'paid',ad_id:'777771',note:'Observed campaign'}),e=>e.status===400);
  assert.equal((await execute('select ad_id from crm_ads where tenant=$1 and ad_id=$2',[tenant,'777771'])).rows.length,0);
});

test('closing requires a scheduling answer and validates every selected service atomically',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  const service=randomUUID(),second=randomUUID(),archived=randomUUID(),foreign=randomUUID(),tag=randomUUID();
  for(const [id,company,kind,active,name] of [[service,tenant,'service',true,'Closure service A'],[second,tenant,'service',true,'Closure service B'],[archived,tenant,'service',false,'Closure archived'],[foreign,otherTenant,'service',true,'Closure foreign'],[tag,tenant,'tag',true,'Closure tag']]){
    await execute('insert into crm_catalog(id,tenant,kind,active,name) values($1,$2,$3,$4,$5)',[id,company,kind,active,name]);
  }
  const baseline=(await execute('select count(*) as n from crm_touches where opportunity=$1',[f.o.id])).rows[0].n;
  for(const input of [{},{had_scheduling:'yes'},{had_scheduling:true},{had_scheduling:true,scheduled_services:[]},{had_scheduling:true,scheduled_services:service},{had_scheduling:true,scheduled_services:['invalid']},{had_scheduling:true,scheduled_services:[archived]},{had_scheduling:true,scheduled_services:[foreign]},{had_scheduling:true,scheduled_services:[tag]},{had_scheduling:true,scheduled_services:[service,randomUUID()]},{had_scheduling:false,scheduled_services:[service]}]){
    await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{source:'organic',...input}),e=>e.status===400);
    assert.equal((await execute('select status from conversations where id=$1',[f.cid])).rows[0].status,'open');
    assert.equal((await execute('select count(*) as n from crm_touches where opportunity=$1',[f.o.id])).rows[0].n,baseline);
    assert.equal((await execute('select count(*) as n from attendance_history where conversation=$1',[f.cid])).rows[0].n,1);
  }
  await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:true,scheduled_services:[service,second,service]});
  const history=(await execute("select * from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows[0];
  assert.equal(history.actor,users.agent.id);
  assert.deepEqual(history.scheduling,{had_scheduling:true,services:[{id:service,name:'Closure service A'},{id:second,name:'Closure service B'}]});
  await execute('update crm_catalog set name=$1,active=false where id=$2',['Renamed service',service]);
  assert.deepEqual((await execute('select scheduling from attendance_history where id=$1',[history.id])).rows[0].scheduling,history.scheduling);
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:true,scheduled_services:[second]}),e=>e.status===409);
  await attendance.status(users.agent,f.cid,'open');
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{source:'organic'}),e=>e.status===400);
  await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:false,scheduled_services:[]});
  const closures=(await execute("select scheduling from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows;
  assert.equal(closures.length,2);assert.ok(closures.some(h=>h.scheduling.had_scheduling===true));
  assert.ok(closures.some(h=>h.scheduling.had_scheduling===false&&h.scheduling.services.length===0));
});
test('a new inbound message after closure returns the case to the queue, preserves history and duplicate delivery cannot steal a later claim',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);await attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'organic'});
  const handler=createInboundHandler({one:async(sql,args)=>(await execute(sql,args)).rows[0],run:execute,id:randomUUID,now,open:JSON.parse,profile:async()=>({}),send:async()=>{},queue:async()=>{},audit:async()=>{},capture:crm.capture,captureReferral:crm.captureReferral});
  const payload={entry:[{id:String(f.account.external),messaging:[{sender:{id:f.message.customer},timestamp:now(),message:{mid:'return-'+f.cid,text:'Hello again'}}]}]};
  await handler(f.account,payload);
  const c=(await execute('select * from conversations where id=$1',[f.cid])).rows[0];
  assert.equal(c.status,'open');assert.equal(c.assigned_to,null);assert.equal(c.assigned_at,null);
  assert.equal((await execute('select owner from crm_opportunities where id=$1',[f.o.id])).rows[0].owner,null);
  assert.equal(canReplyAttendance(users.agent,c),false);
  assert.equal((await execute('select previous_owner from attendance_history where conversation=$1 order by created desc',[f.cid])).rows.some(h=>h.previous_owner===users.agent.id),true);
  await attendance.claim(users.agent2,f.cid);await handler(f.account,payload);
  assert.equal((await execute('select assigned_to from conversations where id=$1',[f.cid])).rows[0].assigned_to,users.agent2.id);
  const activePayload={entry:[{id:String(f.account.external),messaging:[{sender:{id:f.message.customer},timestamp:now(),message:{mid:'ongoing-'+f.cid,text:'Another message'}}]}]};
  await handler(f.account,activePayload);
  assert.equal((await execute('select assigned_to from conversations where id=$1',[f.cid])).rows[0].assigned_to,users.agent2.id);
});
test('WhatsApp contact returning after closure also leaves the previous operator and enters the queue',async()=>{
  const f=await fixture();await attendance.claim(users.admin,f.cid);await attendance.status(users.admin,f.cid,'resolved',{had_scheduling:false,source:'organic'});
  const waid=randomUUID(),customer='5534991112233';
  await execute("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'WA','whatsapp','wa-return','{}','live')",[waid,tenant]);
  await execute('update conversations set account=$1,customer=$2 where id=$3',[waid,customer,f.cid]);
  const account=(await execute('select * from accounts where id=$1',[waid])).rows[0];
  const handler=createInboundHandler({one:async(sql,args)=>(await execute(sql,args)).rows[0],run:execute,id:randomUUID,now,open:JSON.parse,profile:async()=>({}),send:async()=>{},queue:async()=>{},audit:async()=>{},capture:crm.capture,captureReferral:crm.captureReferral});
  await handler(account,{entry:[{changes:[{value:{metadata:{phone_number_id:'wa-return'},messages:[{id:'return-'+f.cid,from:customer,type:'text',text:{body:'Hello again'},timestamp:String(now()/1000)}]}}]}]});
  const c=(await execute('select * from conversations where id=$1',[f.cid])).rows[0];
  assert.equal(c.status,'open');assert.equal(c.assigned_to,null);
  assert.equal((await execute('select owner from crm_opportunities where id=$1',[f.o.id])).rows[0].owner,null);
});
test('Meta media is restricted to HTTPS provider hosts and creative variants are not guessed',()=>{
  assert.equal(metaMediaUrl('javascript:alert(1)'), '');assert.equal(metaMediaUrl('https://facebook.com.evil.invalid/a'),'');assert.equal(metaMediaUrl('https://user:pass@fbcdn.net/a'),'');
  const creative=creativeDetails({id:'31',name:'Creative',asset_feed_spec:{images:[{hash:'a'},{hash:'b'}]},object_story_spec:{video_data:{message:'Offer',video_id:'91'}},thumbnail_url:'https://scontent.fbcdn.net/image'});
  assert.equal(creative.dynamic,true);assert.equal(creative.body,'Offer');assert.equal(creative.video_id,'91');assert.equal(creative.id,'31');
  const touch=referralTouch({source:'ADS',ad_id:'123',ads_context_data:{ad_title:'IG offer',photo_url:'https://scontent.cdninstagram.com/ad',secret:'never'},ctwa_clid:'click',image_url:'https://scontent.fbcdn.net/ad'});
  assert.equal(touch.referral.ads_context_data.ad_title,'IG offer');assert.equal(touch.referral.ads_context_data.secret,undefined);assert.equal(touch.referral.ctwa_clid,'click');
});
test('Meta enrichment stores campaign, adset and creative automatically with cache and safe failure without losing the inbound lead',async()=>{
  const token='PRIVATE-TOKEN',aid='666661';let calls=0,fail=false,creativeId='68';
  const f=await fixture({source_type:'ad',source_id:aid});
  await crm.route(users.admin,'/api/crm/marketing',{token});
  const fetcher=async(url,options)=>{calls++;assert.ok(url.startsWith('https://graph.facebook.com/v26.0/'));assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(url.includes(token),false);return fail?new Response(JSON.stringify({error:{message:token}}),{status:403}):new Response(JSON.stringify({id:aid,name:'Paid ad',campaign:{id:'66',name:'Campaign'},adset:{id:'67',name:'Set'},creative:{id:creativeId,name:'Visual',body:'Service offer',image_url:'https://scontent.fbcdn.net/ad'}}));};
  const auto=createCrm({pool,permitted,now,open:JSON.parse,seal:JSON.stringify,fetcher});
  await auto.capture(f.conversation,f.account,f.message);
  const ad=(await execute('select * from crm_ads where tenant=$1 and ad_id=$2',[tenant,aid])).rows[0];
  assert.equal(ad.campaign_name,'Campaign');assert.equal(ad.adset_name,'Set');assert.equal(ad.creative.id,'68');assert.equal(ad.verified,true);
  await auto.capture(f.conversation,f.account,{...f.message,external:randomUUID()});assert.equal(calls,1);
  fail=true;const sync=createMetaAttribution({pool,open:JSON.parse,now,fetcher});
  assert.equal((await sync.syncAd(tenant,aid,{force:true})).ok,false);
  const state=await auto.state(users.admin);assert.equal(JSON.stringify(state).includes(token),false);
  assert.equal(state.ads.find(a=>a.ad_id===aid).creative.id,'68');
  assert.equal(state.touches.some(t=>t.opportunity===f.o.id&&t.ad_id===aid),true);
  fail=false;creativeId='69';await sync.syncAd(tenant,aid,{force:true});
  assert.equal((await execute('select creative from crm_ads where tenant=$1 and ad_id=$2',[tenant,aid])).rows[0].creative.id,'69');
  assert.equal((await execute('select meta_snapshot from crm_touches where opportunity=$1 and ad_id=$2',[f.o.id,aid])).rows[0].meta_snapshot.creative.id,'68');
  await attendance.claim(users.agent,f.cid);await attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'paid',ad_id:aid});
  const touches=(await execute('select * from crm_touches where opportunity=$1',[f.o.id])).rows;
  assert.equal(selectedTouch({touches}).meta_snapshot.creative.id,'68');
  await assert.rejects(auto.route(users.agent,'/api/crm/ads/sync',{}),e=>e.status===403);
  assert.equal((await sync.syncAd(otherTenant,aid,{force:true})).ok,false);
});
test('PostgreSQL migrations protect every CRM and attendance table with RLS',async()=>{
  const rows=(await execute("select relname,relrowsecurity from pg_class where relname like 'crm_%' or relname='attendance_history'")).rows.filter(r=>!r.relname.endsWith('_idx')&&!r.relname.endsWith('_pkey')&&!r.relname.endsWith('_key'));
  for(const name of ['crm_contacts','crm_opportunities','crm_events','crm_settings','attendance_history','crm_pending_referrals'])assert.equal(rows.find(r=>r.relname===name)?.relrowsecurity,true);
});
test('inbound CRM capture is idempotent and retains paid attribution on later plain messages',async()=>{
  const f=await fixture({source_type:'ad',source_id:'123',ctwa_clid:'click'});
  await crm.capture(f.conversation,f.account,f.message);
  await crm.capture(f.conversation,f.account,{...f.message,external:randomUUID(),referral:undefined});
  assert.equal((await execute('select count(*) as n from crm_opportunities where conversation=$1',[f.cid])).rows[0].n,1);
  const touches=(await execute('select * from crm_touches where opportunity=$1',[f.o.id])).rows;
  assert.equal(touches.length,1);assert.equal(touches[0].ad_id,'123');assert.equal(touches[0].referral.ctwa_clid,'click');
});
test('standalone ad referrals preceding a message are retained without a fake inbound message',async()=>{
  const cid=randomUUID(),customer=randomUUID(),account=(await execute('select * from accounts where id=$1',[accountId])).rows[0];
  await crm.captureReferral(account,{customer,external:'ref-'+cid,timestamp:now()-5000,referral:{ad_id:'555',source:'ADS'}});
  await execute("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,'Client','open',$5,$5)",[cid,tenant,accountId,customer,now()]);
  const c=(await execute('select * from conversations where id=$1',[cid])).rows[0];
  await crm.capture(c,account,{customer,external:'message-'+cid,timestamp:now()});
  const o=(await execute('select * from crm_opportunities where conversation=$1',[cid])).rows[0];
  assert.equal((await execute('select ad_id from crm_touches where opportunity=$1',[o.id])).rows[0].ad_id,'555');
  assert.equal((await execute('select count(*) as n from messages where conversation=$1',[cid])).rows[0].n,0);
});
test('claim is atomic and CRM responsibility follows the winning operator',async()=>{
  const f=await fixture();
  const result=await Promise.allSettled([attendance.claim(users.agent,f.cid),attendance.claim(users.agent2,f.cid)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  const c=(await execute('select * from conversations where id=$1',[f.cid])).rows[0];assert.equal(c.assigned_to,users.agent.id);
  assert.equal((await execute('select owner from crm_opportunities where id=$1',[f.o.id])).rows[0].owner,users.agent.id);
  await assert.rejects(attendance.claim(users.viewer,f.cid),e=>e.status===403);
});
test('reception can reopen and transfer a closed case; agents and other tenants cannot',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);await attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'organic'});
  await assert.rejects(attendance.transfer(users.agent,f.cid,{assigned_to:users.agent2.id,reopen:true}),e=>e.status===403);
  await assert.rejects(attendance.transfer(users.outsider,f.cid,{assigned_to:users.agent2.id,reopen:true}),e=>e.status===403);
  await attendance.transfer(users.receptionist,f.cid,{assigned_to:users.agent2.id,reopen:true});
  const c=(await execute('select * from conversations where id=$1',[f.cid])).rows[0];assert.equal(c.status,'open');assert.equal(c.assigned_to,users.agent2.id);
  assert.equal((await execute('select count(*) as n from attendance_history where conversation=$1',[f.cid])).rows[0].n,3);
});
test('CRM state and edits cannot expose another operator opportunity or cross a tenant',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  assert.ok((await crm.state(users.agent)).attendance_history.some(h=>h.conversation===f.cid));
  assert.ok(!(await crm.state(users.agent2)).attendance_history.some(h=>h.conversation===f.cid));
  assert.equal((await crm.state(users.agent2)).opportunities.some(o=>o.id===f.o.id),false);
  assert.equal((await crm.state(users.outsider)).opportunities.length,0);
  await assert.rejects(crm.route(users.agent2,'/api/crm/opportunities/'+f.o.id,dealInput(f.o)),e=>e.status===403);
  await assert.rejects(crm.route(users.viewer,'/api/crm/opportunities/'+f.o.id,dealInput(f.o)),e=>e.status===403);
});
test('services have editable prices, tags are tenant-owned and pipeline movements do not create sales',async()=>{
  await crm.route(users.admin,'/api/crm/catalog',{kind:'service',name:'Service test',price:'129.90',description:'Description'});
  const s=(await execute("select * from crm_catalog where name='Service test'")).rows[0];assert.equal(s.price_cents,12990);
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  await crm.route(users.agent,'/api/crm/opportunities/'+f.o.id,{...dealInput(f.o),owner:users.agent.id,stage:'won',service:s.id});
  assert.equal((await execute('select count(*) as n from crm_events where opportunity=$1',[f.o.id])).rows[0].n,0);
  await assert.rejects(crm.route(users.agent,'/api/crm/catalog',{kind:'service',name:'Denied',price:'1'}),e=>e.status===403);
});
test('conversion is idempotent, money/date validated and voiding preserves audited history',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);const input={id:randomUUID(),kind:'sale',occurred:now(),amount:'120.10',note:'Actual sale'};
  await crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/events',input);
  await crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/events',input);
  const e=(await execute('select * from crm_events where opportunity=$1',[f.o.id])).rows[0];assert.equal(e.amount_cents,12010);assert.equal(e.actor,users.agent.id);
  assert.equal((await execute('select count(*) as n from crm_events where opportunity=$1',[f.o.id])).rows[0].n,1);
  await assert.rejects(crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/events',{...input,amount:'121'}),e=>e.status===409);
  await assert.rejects(crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/events',{...input,id:randomUUID(),occurred:now()+100000}),/futura/);
  await crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/void',{id:input.id,reason:'Input mistake'});
  assert.equal((await execute('select voided from crm_events where id=$1',[input.id])).rows[0].voided,true);
});
test('marketing credentials remain private and enrichment preserves the service mapping',async()=>{
  await crm.route(users.admin,'/api/crm/marketing',{token:'PRIVATE'});
  await crm.route(users.admin,'/api/crm/ads',{ad_id:'123',ad_name:'Manual'});
  await crm.route(users.admin,'/api/crm/ads/123/enrich',{});
  const state=await crm.state(users.admin);assert.equal(state.marketingConfigured,true);assert.equal(state.ads.find(a=>a.ad_id==='123').campaign_name,'Campaign');assert.equal(JSON.stringify(state).includes('PRIVATE'),false);
  await assert.rejects(crm.route(users.agent,'/api/crm/ads/123/enrich',{}),e=>e.status===403);
});
test('reports count converted leads once, sum real sales, exclude cancellations and preserve operator credit',()=>{
  const opportunities=[{id:'a',conversation:'c',contact:'ct',first_contact:100,stage:'won',owner:'u',owner_name:'Owner',touches:[{created:100,source:'paid',ad_id:'ad'}],ad:{campaign_name:'Campaign'}}];
  const events=[{opportunity:'a',kind:'sale',occurred:200,amount_cents:100,actor:'v',actor_name:'Seller'},{opportunity:'a',kind:'sale',occurred:300,amount_cents:200,actor:'v',actor_name:'Seller'},{opportunity:'a',kind:'sale',occurred:400,amount_cents:999,voided:true}];
  const result=summarize(opportunities,events,[{conversation:'c',direction:'in',created:100},{conversation:'c',direction:'out',state:'failed',operator_id:'u',created:150},{conversation:'c',direction:'out',state:'sent',operator_id:'u',operator_name:'Owner',created:160}]);
  assert.equal(result.groups[0].sales,1);assert.equal(result.groups[0].clients,1);assert.equal(result.groups[0].revenue_cents,300);assert.equal(result.groups[0].median_conversion_ms,100);
  assert.equal(result.operators.find(p=>p.key==='v').sales,2);assert.equal(result.operators.find(p=>p.key==='u').median_response_ms,60);
});

test('new campaigns do not change latest-paid attribution frozen at the first sale',()=>{
  const o={touches:[{id:'a',created:1,source:'paid',ad_id:'later'}],conversions:[{kind:'sale',occurred:1,attribution:{last_paid:{source:'paid',ad_id:'original'}}}]};
  assert.equal(selectedTouch(o,'last_paid').ad_id,'original');
});

test('historical replies without an identified operator cannot become a fabricated first response time',()=>{
  const o={id:'a',conversation:'c',contact:'ct',first_contact:100,stage:'new',touches:[]};
  const report=summarize([o],[],[{conversation:'c',direction:'in',created:100},{conversation:'c',direction:'out',state:'sent',created:120},{conversation:'c',direction:'out',state:'sent',created:140,operator_id:'u',operator_name:'User'}]);
  assert.equal(report.operators.find(p=>p.key==='u').median_response_ms,null);
});

test('agents cannot link or edit contacts belonging to another operator on the same channel',async()=>{
  const f=await fixture(),g=await fixture();await attendance.claim(users.agent,f.cid);await attendance.claim(users.agent2,g.cid);
  await assert.rejects(crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/contact',{link:g.o.contact}),e=>e.status===403);
  await crm.route(users.admin,'/api/crm/opportunities/'+f.o.id+'/contact',{link:g.o.contact});
  await assert.rejects(crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/contact',{name:'Unauthorized edit'}),e=>e.status===403);
});

test('archived service assignments are retained during unrelated opportunity edits',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  await crm.route(users.admin,'/api/crm/catalog',{kind:'service',name:'Archived test',price:'12.30'});
  const service=(await execute("select * from crm_catalog where name='Archived test'")).rows[0];
  await crm.route(users.agent,'/api/crm/opportunities/'+f.o.id,{...dealInput(f.o),owner:users.agent.id,service:service.id});
  await crm.route(users.admin,'/api/crm/catalog',{id:service.id,kind:'service',name:service.name,price:'12.30',active:false});
  const o=(await execute('select * from crm_opportunities where id=$1',[f.o.id])).rows[0];
  await crm.route(users.agent,'/api/crm/opportunities/'+o.id,{...dealInput(o),notes:'Updated notes'});
  assert.equal((await execute('select service from crm_opportunities where id=$1',[o.id])).rows[0].service,service.id);
});

test('transfer immediately removes former owner access and rejects targets without account permission',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  await attendance.transfer(users.receptionist,f.cid,{assigned_to:users.agent2.id});
  assert.equal((await crm.state(users.agent)).opportunities.some(o=>o.id===f.o.id),false);
  assert.equal((await crm.state(users.agent2)).opportunities.some(o=>o.id===f.o.id),true);
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved'),e=>e.status===403);
  await execute("update users set accounts='[]' where id=$1",[users.agent.id]);
  try{await assert.rejects(attendance.transfer(users.receptionist,f.cid,{assigned_to:users.agent.id}),e=>e.status===403);}finally{await execute('update users set accounts=$1 where id=$2',[JSON.stringify(users.agent.accounts),users.agent.id]);}
});

test('malformed service prices return a validation error rather than a server exception',async()=>{
  await assert.rejects(crm.route(users.admin,'/api/crm/catalog',{kind:'service',name:'Bad price',price:'-1'}),e=>e.status===400);
});

test('legacy demonstration conversations are excluded even after their account changes to live',async()=>{
  assert.equal(realOpportunity({mode:'live',customer:'demo-1'}),false);
  assert.equal(realOpportunity({mode:'demo',customer:'123'}),false);
  assert.equal(realOpportunity({mode:'live',customer:'123'}),true);
  const f=await fixture();await execute("update conversations set customer='demo-test' where id=$1",[f.cid]);await attendance.claim(users.agent,f.cid);
  await assert.rejects(crm.route(users.agent,'/api/crm/opportunities/'+f.o.id+'/events',{id:randomUUID(),kind:'sale',amount:'10',occurred:now()}),/demonstrativas/);
});
