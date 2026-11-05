import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createCrm} from '../lib/crm-store.mjs';
import {createAttendance} from '../lib/attendance-store.mjs';
import {seesAttendance,worksAttendance,canReplyAttendance} from '../lib/attendance-policy.mjs';
import {referralTouch,cents,selectedTouch,automaticPaidTouch,summarize,realOpportunity} from '../lib/crm-domain.mjs';
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
  for(const file of ['202609290001_initial','202609290003_whatsapp_bridge','202609300004_sac','202609300005_crm','202609300006_attendance','202609300007_meta_attribution','202610020008_closure_scheduling','20261016042106_contact_directory_and_channel_activation','202610190001_cashbarber','202610190002_booking_outcomes','202610200001_channel_deletion','202610210002_bulk_closure_reason','202610210003_instagram_attendance','202610210004_instagram_social_attribution','202610220001_campaign_booking_checks','202610240002_cashbarber_changes','20261031175842_message_timing','202611040001_campaign_check_history']){
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

test('attendance tags support multiple choices without replacing CRM fields and preserve permissions, history and concurrent changes',async()=>{
 const f=await fixture();await attendance.claim(users.agent,f.cid);
 const makeTag=async(name,kind='tag',t=tenant)=>(await execute('insert into crm_catalog(tenant,kind,name) values($1,$2,$3) returning id',[t,kind,name])).rows[0].id;
 const first=await makeTag('Prioridade'),second=await makeTag('Retorno'),foreign=await makeTag('Outro tenant','tag',otherTenant),service=await makeTag('Serviço','service');
 const before=(await execute('select * from crm_opportunities where id=$1',[f.o.id])).rows[0];
 await assert.rejects(crm.setAttendanceTags(users.agent,f.cid,null),e=>e.status===400);
 await crm.setAttendanceTags(users.agent,f.cid,{tags:[first,second,first],expectedTags:[]});
 const saved=(await execute('select tag from crm_opportunity_tags where opportunity=$1',[f.o.id])).rows.map(t=>t.tag).sort();assert.deepEqual(saved,[first,second].sort());
 const after=(await execute('select * from crm_opportunities where id=$1',[f.o.id])).rows[0];for(const field of ['notes','stage','owner','service','offer','contact'])assert.deepEqual(after[field],before[field]);
 const history=(await execute('select * from crm_history where opportunity=$1 order by created desc',[f.o.id])).rows.find(h=>h.action.startsWith('Tags do atendimento'));assert.equal(history.actor_name,users.agent.name);assert.match(history.action,/Prioridade/);assert.match(history.action,/Retorno/);
 await assert.rejects(crm.setAttendanceTags(users.agent,f.cid,{tags:[],expectedTags:[]}),e=>e.status===409);
 await assert.rejects(crm.setAttendanceTags(users.agent2,f.cid,{tags:[],expectedTags:saved}),e=>e.status===403);
 await assert.rejects(crm.setAttendanceTags(users.viewer,f.cid,{tags:[],expectedTags:saved}),e=>e.status===403);
 await assert.rejects(crm.setAttendanceTags(users.outsider,f.cid,{tags:[],expectedTags:saved}),e=>e.status===404);
 for(const tag of [foreign,service])await assert.rejects(crm.setAttendanceTags(users.agent,f.cid,{tags:[tag],expectedTags:saved}),e=>e.status===400);
 for(const tags of [[null],['invalid'],Array(31).fill(first)])await assert.rejects(crm.setAttendanceTags(users.agent,f.cid,{tags,expectedTags:saved}),e=>e.status===400);
 await execute('update crm_catalog set active=false where id=$1',[first]);await crm.setAttendanceTags(users.admin,f.cid,{tags:[first],expectedTags:saved});
 await crm.setAttendanceTags(users.receptionist,f.cid,{tags:[],expectedTags:[first]});
 await assert.rejects(crm.setAttendanceTags(users.agent,f.cid,{tags:[first],expectedTags:[]}),e=>e.status===400);
 assert.equal((await execute('select * from crm_opportunity_tags where opportunity=$1',[f.o.id])).rows.length,0);
 await execute("update conversations set status='resolved' where id=$1",[f.cid]);await assert.rejects(crm.setAttendanceTags(users.admin,f.cid,{tags:[second],expectedTags:[]}),e=>e.status===403);
 const queued=await fixture();await assert.rejects(crm.setAttendanceTags(users.admin,queued.cid,{tags:[second],expectedTags:[]}),e=>e.status===403);
});

test('attendance tags repair a missing CRM record inside the same transaction',async()=>{
 const cid=randomUUID(),tag=(await execute("insert into crm_catalog(tenant,kind,name) values($1,'tag','Cadastro legado') returning id",[tenant])).rows[0].id;
 await execute("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,$4,'Cliente legado','open',$5,$5,$6)",[cid,tenant,accountId,randomUUID(),now(),users.agent.id]);
 await crm.setAttendanceTags(users.agent,cid,{tags:[tag],expectedTags:[]});
 const o=(await execute('select * from crm_opportunities where conversation=$1',[cid])).rows[0];assert.ok(o);assert.equal((await execute('select tag from crm_opportunity_tags where opportunity=$1',[o.id])).rows[0].tag,tag);
});

test('bulk queue closure preserves active cases, new messages, permissions and booking evidence',async()=>{
  const fresh=await fixture(),claimed=await fixture(),changed=await fixture(),replied=await fixture(),returned=await fixture(),booked=await fixture();
  await attendance.claim(users.agent,returned.cid);await attendance.transfer(users.admin,returned.cid,{assigned_to:null});
  await execute("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'out','Resposta externa',$3,'sent')",[randomUUID(),replied.cid,now()]);
  await execute("insert into cashbarber_bookings(id,tenant,conversation,actor,state,quote,created,updated,expires) values($1,$2,$3,$4,'uncertain','{}',$5,$5,$5)",[randomUUID(),tenant,booked.cid,users.admin.id,now()]);
  for(const role of ['agent','viewer'])await assert.rejects(attendance.queueClosePreview(users[role]),e=>e.status===403);
  const preview=await attendance.queueClosePreview(users.receptionist),ids=preview.items.map(c=>c.id);
  for(const f of [fresh,replied,returned])assert.ok(ids.includes(f.cid));assert.ok(!ids.includes(booked.cid));
  assert.equal((await attendance.queueClosePreview({...users.receptionist,accounts:[]})).items.length,0);
  const selected=preview.items.filter(c=>[fresh.cid,claimed.cid,changed.cid].includes(c.id));assert.equal(selected.length,3);
  assert.equal((await attendance.closeQueue({...users.admin,tenant:otherTenant},{reason:'Clientes atendidos diretamente pelo celular',items:selected})).closed.length,0);
  assert.equal((await attendance.closeQueue({...users.receptionist,accounts:[]},{reason:'Clientes atendidos diretamente pelo celular',items:selected})).closed.length,0);
  await attendance.claim(users.agent,claimed.cid);
  // Even an inbound message with an unchanged timestamp invalidates the preview.
  await execute("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in','Nova mensagem',$3,'received')",[randomUUID(),changed.cid,now()]);
  await assert.rejects(attendance.closeQueue(users.agent,{reason:'Clientes atendidos diretamente pelo celular',items:selected}),e=>e.status===403);
  assert.equal((await attendance.closeQueue(users.outsider,{reason:'Clientes atendidos diretamente pelo celular',items:selected}).catch(e=>({status:e.status}))).status,403);
  for(const reason of [undefined,'','   ','x'.repeat(1001)])await assert.rejects(attendance.closeQueue(users.admin,{reason,items:selected}),e=>e.status===400);
  assert.equal((await execute('select status from conversations where id=$1',[fresh.cid])).rows[0].status,'open');
  const result=await attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:selected});assert.deepEqual(result.closed,[fresh.cid]);assert.equal(result.skipped,2);
  assert.equal((await execute('select status from conversations where id=$1',[fresh.cid])).rows[0].status,'resolved');
  const h=(await execute("select * from attendance_history where conversation=$1 and action='Atendimento encerrado em massa sem início'",[fresh.cid])).rows[0];
  assert.equal(h.reason,'Clientes atendidos diretamente pelo celular');assert.equal(h.actor_name,users.admin.name);
  assert.match((await execute("select action from audit where tenant=$1 order by created desc",[tenant])).rows[0].action,/Encerramento em massa por admin: 1 atendimento\(s\). Motivo: Clientes atendidos diretamente pelo celular/);
  assert.equal(h.actor,users.admin.id);assert.equal(h.scheduling,null);assert.equal(h.next_owner,null);
  assert.equal((await attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:selected})).closed.length,0);
  // Historical replies and ownership must not hide conversations currently waiting in the queue.
  const returningItems=preview.items.filter(c=>[replied.cid,returned.cid].includes(c.id));
  const returningResult=await attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:returningItems});
  assert.deepEqual(new Set(returningResult.closed),new Set([replied.cid,returned.cid]));assert.equal(returningResult.skipped,0);
  assert.equal((await execute('select status from conversations where id=$1',[booked.cid])).rows[0].status,'open');
  assert.ok(!(await attendance.queueClosePreview(users.admin)).items.some(c=>c.id===claimed.cid));
  await assert.rejects(attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:[]}),e=>e.status===400);
  await assert.rejects(attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:[selected[0],selected[0]]}),e=>e.status===400);
  await assert.rejects(attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:[selected[0],{...selected[0],id:selected[0].id.toUpperCase()}]}),e=>e.status===400);
  await assert.rejects(attendance.closeQueue(users.admin,{reason:'Clientes atendidos diretamente pelo celular',items:[{id:fresh.cid}]}),e=>e.status===400);
});

test('confirmed CashBarber prices survive closing, catalogue changes and reopening without duplicate inclusion',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  const booking=randomUUID(),quote={clientId:'123',clientName:'Maria',service:'Manicure',professionalName:'Isaura',date:'2026-10-22',start:'13:00',end:'13:50',price:4500,duration:50};
  await execute("insert into cashbarber_bookings(id,tenant,conversation,actor,state,quote,receipt,created,updated,expires) values($1,$2,$3,$4,'confirmed',$5,$6,$7,$7,$7)",[booking,tenant,f.cid,users.agent.id,JSON.stringify(quote),JSON.stringify({externalId:'987'}),now()]);
  await assert.rejects(execute("update cashbarber_bookings set quote=jsonb_set(quote,'{price}','9999') where id=$1",[booking]),/não podem ser alterados/);
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:true,cash_booking_ids:[]}),e=>e.status===409);
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:false,cash_booking_ids:[booking]}),/Há serviços confirmados/);
  await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:true,cash_booking_ids:[booking],cash_price:9999});
  const h=(await execute("select * from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows[0];
  assert.equal(h.scheduling.services[0].price_cents,4500);assert.equal(h.scheduling.services[0].name,'Manicure');assert.equal(h.scheduling.booked_total_cents,4500);
  assert.equal((await execute('select closure_id from cashbarber_bookings where id=$1',[booking])).rows[0].closure_id,h.id);
  assert.ok((await crm.state(users.agent)).bookings.some(b=>b.id===booking));
  assert.ok(!(await crm.state(users.agent2)).bookings.some(b=>b.id===booking));
  assert.ok(!(await crm.state(users.outsider)).bookings.some(b=>b.id===booking));
  await attendance.status(users.agent,f.cid,'open');await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:false});
  const history=(await execute("select scheduling from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows;
  assert.equal(history.flatMap(h=>h.scheduling.services).filter(s=>s.booking_id===booking).length,1);
  assert.equal((await execute('select quote from cashbarber_bookings where id=$1',[booking])).rows[0].quote.price,4500);
});

test('uncertain CashBarber results block closure and zero-price plan reservations are included',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);const booking=randomUUID();
  const quote={clientId:'123',clientName:'Maria',service:'Manicure no plano',professionalName:'Isaura',date:'2026-10-22',start:'13:00',end:'13:50',price:0};
  await execute("insert into cashbarber_bookings(id,tenant,conversation,actor,state,quote,created,updated,expires) values($1,$2,$3,$4,'uncertain',$5,$6,$6,$6)",[booking,tenant,f.cid,users.agent.id,JSON.stringify(quote),now()]);
  await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:false}),/agendamento pendente/);
  await execute("update cashbarber_bookings set state='confirmed' where id=$1",[booking]);
  await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:true,cash_booking_ids:[booking]});
  const h=(await execute("select scheduling from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows[0];
  assert.equal(h.scheduling.services[0].price_cents,0);assert.equal(h.scheduling.had_scheduling,true);
});

test('organic closure without scheduling repairs a conversation missing its CRM link atomically',async()=>{
  const f=await fixture();await attendance.claim(users.agent,f.cid);
  await execute('delete from crm_touches where opportunity=$1',[f.o.id]);
  await execute('delete from crm_opportunities where id=$1',[f.o.id]);
  await execute("update accounts set channel='whatsapp' where id=$1",[accountId]);
  const phone='5534999998765';
  await execute('update conversations set customer=$1 where id=$2',[phone,f.cid]);
  await execute('update crm_contacts set account=$1,phone=$2,name_manual=true where id=$3',[accountId,phone,f.o.contact]);
  try{
    await assert.rejects(attendance.status(users.agent2,f.cid,'resolved',{source:'organic',had_scheduling:false}),e=>e.status===403);
    assert.equal((await execute('select id from crm_opportunities where conversation=$1',[f.cid])).rows.length,0);
    await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:false,scheduled_services:[],cash_booking_ids:[]});
    const o=(await execute('select * from crm_opportunities where conversation=$1',[f.cid])).rows[0];
    assert.equal(o.contact,f.o.contact);assert.equal(o.owner,users.agent.id);
    assert.equal((await execute('select count(*) as n from crm_contacts where account=$1 and phone=$2',[accountId,phone])).rows[0].n,1);
    assert.equal((await execute('select source from crm_touches where opportunity=$1',[o.id])).rows[0].source,'organic');
    const h=(await execute("select scheduling from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows[0];
    assert.equal(h.scheduling.had_scheduling,false);assert.deepEqual(h.scheduling.services,[]);
    await attendance.status(users.agent,f.cid,'open');
    await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:false});
    assert.equal((await execute('select id from crm_opportunities where conversation=$1',[f.cid])).rows[0].id,o.id);
  }finally{await execute("update accounts set channel='instagram' where id=$1",[accountId]);}
});

test('recovered original webhook ad evidence enriches unknown attribution without duplicate touches or overriding manual corrections',async()=>{
  const f=await fixture();const before=(await execute('select first_contact from crm_opportunities where id=$1',[f.o.id])).rows[0].first_contact;
  await execute("insert into crm_touches(tenant,opportunity,event_key,source,evidence,referral,created) values($1,$2,'manual-correction','organic','manual',$3,$4)",[tenant,f.o.id,JSON.stringify({correct_first:true}),now()+1]);
  const message={...f.message,referral:{source_type:'ad',source_id:'120253089514020134',source_app:'instagram',headline:'Day Use'}};
  await crm.capture(f.conversation,f.account,message);await crm.capture(f.conversation,f.account,message);
  const touches=(await execute('select * from crm_touches where opportunity=$1',[f.o.id])).rows;assert.equal(touches.length,2);
  assert.equal(touches.find(t=>t.event_key===f.message.external).source,'paid');assert.equal(touches.find(t=>t.event_key===f.message.external).referral.source_app,'instagram');assert.equal(selectedTouch({touches}).source,'organic');
  assert.equal((await execute('select first_contact from crm_opportunities where id=$1',[f.o.id])).rows[0].first_contact,before);
});

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

test('closing requires CashBarber professional and services when no central booking exists, with optional missing client',async()=>{
  const attendance=createAttendance({pool,permitted,now,resolveExternalScheduling:async(user,input)=>{if(!input?.services?.length)throw Object.assign(Error('Selecione os dados CashBarber'),{status:400});return {services:[{id:'cashbarber-service:1:2',name:'Serviço CashBarber',professional:'Isaura',source:'cashbarber_external'}],client_id:null,client_name:'',client_not_found:true};}});
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
  await attendance.status(users.agent,f.cid,'resolved',{source:'organic',had_scheduling:true,external_scheduling:{services:[{professional_id:'1',service_id:'2'}],client_not_found:true}});
  const history=(await execute("select * from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows[0];
  assert.equal(history.actor,users.agent.id);
  assert.deepEqual(history.scheduling,{had_scheduling:true,booked_total_cents:0,services:[{id:'cashbarber-service:1:2',name:'Serviço CashBarber',professional:'Isaura',source:'cashbarber_external'}],external_client:{id:null,name:'',not_found:true}});
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

test('Instagram interactions close individually and in bulk without starting attendances',async()=>{
  const social=await fixture(),changed=await fixture(),claimed=await fixture(),bulk=await fixture(),ordinary=await fixture();
  for(const f of [social,changed,claimed,bulk])await execute('update conversations set attendance_eligible=false where id=$1',[f.cid]);
  const snapshot=f=>({updated:f.conversation.updated,last_inbound:f.conversation.last_inbound});
  await assert.rejects(attendance.closeInteraction(users.viewer,social.cid,snapshot(social)),e=>e.status===403);
  await assert.rejects(attendance.closeInteraction({...users.agent,accounts:[]},social.cid,snapshot(social)),e=>e.status===403);
  await assert.rejects(attendance.closeInteraction(users.outsider,social.cid,snapshot(social)),e=>e.status===404);
  await assert.rejects(attendance.closeInteraction(users.admin,ordinary.cid,snapshot(ordinary)),e=>e.status===409);
  await attendance.claim(users.agent,claimed.cid);
  await assert.rejects(attendance.closeInteraction(users.admin,claimed.cid,snapshot(claimed)),e=>e.status===409);
  await execute('update conversations set last_inbound=last_inbound+1000 where id=$1',[changed.cid]);
  await assert.rejects(attendance.closeInteraction(users.admin,changed.cid,snapshot(changed)),e=>e.status===409);
  const jobsBefore=(await execute('select count(*) as n from jobs')).rows[0].n;
  await attendance.closeInteraction(users.agent,social.cid,snapshot(social));
  const record=(await execute('select * from conversations where id=$1',[social.cid])).rows[0];
  assert.equal(record.status,'resolved');assert.equal(record.attendance_eligible,false);assert.equal(record.assigned_to,null);
  assert.equal((await execute('select action from attendance_history where conversation=$1',[social.cid])).rows[0].action,'Interação do Instagram encerrada');
  const preview=await attendance.queueClosePreview(users.receptionist,{scope:'interactions'});
  assert.ok(preview.items.some(i=>i.id===bulk.cid));assert.ok(!preview.items.some(i=>[ordinary.cid,social.cid,claimed.cid].includes(i.id)));
  assert.ok(!(await attendance.queueClosePreview(users.admin)).items.some(i=>i.id===bulk.cid));
  const item=preview.items.find(i=>i.id===bulk.cid);
  const ordinaryItem=(await attendance.queueClosePreview(users.admin)).items.find(i=>i.id===ordinary.cid);
  assert.deepEqual((await attendance.closeQueue(users.admin,{scope:'interactions',reason:'Somente interações',items:[ordinaryItem]})).closed,[]);
  assert.deepEqual((await attendance.closeQueue(users.admin,{reason:'Somente fila',items:[item]})).closed,[]);
  await assert.rejects(attendance.closeQueue(users.agent,{scope:'interactions',reason:'Interações revisadas',items:[item]}),e=>e.status===403);
  const result=await attendance.closeQueue(users.receptionist,{scope:'interactions',reason:'Interações revisadas',items:[item]});assert.deepEqual(result.closed,[bulk.cid]);
  const history=(await execute('select * from attendance_history where conversation=$1',[bulk.cid])).rows[0];
  assert.equal(history.action,'Interação do Instagram encerrada em massa');assert.equal(history.reason,'Interações revisadas');assert.equal(history.scheduling,null);
  assert.equal((await execute('select count(*) as n from jobs')).rows[0].n,jobsBefore);
  await assert.rejects(attendance.queueClosePreview(users.admin,{scope:'other'}),e=>e.status===400);
});



test('automatically attributed paid closures reject changed origin or ad and retain webhook evidence after reopening',async()=>{
  const aid='9876543210123',f=await fixture({source_type:'ad',source_id:aid,headline:'Automatic campaign'});
  await attendance.claim(users.agent,f.cid);
  for(const input of [{source:'organic'},{source:'paid',ad_id:'888881'},{source:'paid'}]){
    await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,...input}),e=>e.status===409&&/automaticamente/.test(e.message));
    assert.equal((await execute('select status from conversations where id=$1',[f.cid])).rows[0].status,'open');
  }
  for(let cycle=0;cycle<2;cycle++){
    await attendance.status(users.agent,f.cid,'resolved',{had_scheduling:false,source:'paid',ad_id:aid});
    const touches=(await execute('select * from crm_touches where opportunity=$1',[f.o.id])).rows;
    assert.equal(automaticPaidTouch({touches}).ad_id,aid);
    assert.equal(touches.filter(t=>t.evidence==='manual').length,0);
    if(cycle===0)await attendance.status(users.agent,f.cid,'open');
  }
});

test('automatic paid lock requires matching active webhook evidence and respects explicit CRM corrections',()=>{
  const webhook={id:'a',created:1,source:'paid',ad_id:'123',evidence:'webhook'};
  assert.equal(automaticPaidTouch({touches:[webhook]}),webhook);
  assert.equal(automaticPaidTouch({touches:[{...webhook,evidence:'manual'}]}),null);
  assert.equal(automaticPaidTouch({touches:[{...webhook,ignored_for_attribution:true}]}),null);
  const correction={id:'b',created:2,source:'paid',ad_id:'123',evidence:'manual',referral:{correct_first:true}};
  assert.equal(automaticPaidTouch({touches:[webhook,correction]}),webhook);
  assert.equal(automaticPaidTouch({touches:[webhook,{...correction,ad_id:'456'}]}),null);
  assert.equal(automaticPaidTouch({touches:[webhook,{...correction,source:'organic',ad_id:''}]}),null);
});


test('information-only closure is persisted distinctly without service requirements and cannot hide confirmed bookings',async()=>{
 const f=await fixture();await attendance.claim(users.agent,f.cid);
 const input={source:'organic',had_scheduling:false,scheduling_outcome:'information'};
 await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{...input,had_scheduling:true}),/não pode ser combinado/);
 await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{...input,scheduling_outcome:'invalid'}),/inválida/);
 await attendance.status(users.agent,f.cid,'resolved',input);
 const history=(await execute("select scheduling from attendance_history where conversation=$1 and action='Atendimento finalizado'",[f.cid])).rows[0];
 assert.equal(history.scheduling.outcome,'information');assert.equal(history.scheduling.had_scheduling,false);assert.deepEqual(history.scheduling.services,[]);
 await attendance.status(users.agent,f.cid,'open');
 const booking=randomUUID(),quote={clientId:'123',clientName:'Maria',service:'Manicure',professionalName:'Isaura',date:'2026-10-22',start:'13:00',end:'13:50',price:4500,duration:50};
 await execute("insert into cashbarber_bookings(id,tenant,conversation,actor,state,quote,receipt,created,updated,expires) values($1,$2,$3,$4,'confirmed',$5,$6,$7,$7,$7)",[booking,tenant,f.cid,users.agent.id,JSON.stringify(quote),JSON.stringify({externalId:'987'}),now()]);
 await assert.rejects(attendance.status(users.agent,f.cid,'resolved',{...input,cash_booking_ids:[booking]}),/Há serviços confirmados/);
});
