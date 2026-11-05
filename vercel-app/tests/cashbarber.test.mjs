import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {availableSlots,bookingInput} from '../lib/cashbarber-domain.mjs';
import {createCashbarber} from '../lib/cashbarber-store.mjs';
import {validQrSignature} from '../lib/qr-protocol.mjs';
import {createCashbarberClient} from '../lib/cashbarber-client.mjs';

test('availability respects full duration, adjacent bookings, breaks, irregular starts and past dates',()=>{
 const slots=availableSlots({date:'2026-10-20',now:0,duration:50,work:[{start:'09:00',end:'12:00'}],blocks:[{start:'09:50',end:'10:40'}]});assert.ok(slots.includes('09:00'));assert.ok(!slots.includes('09:05'));assert.ok(slots.includes('10:40'));assert.ok(slots.includes('10:45'));assert.ok(!slots.includes('11:15'));
 assert.deepEqual(availableSlots({date:'2020-01-01',duration:50,work:[{start:'09:00',end:'12:00'}]}),[]);assert.throws(()=>bookingInput({date:'2026-02-30',start:'10:00'}));
});

test('same-day availability queries tolerate an elapsed start, while booking confirmation rejects it',()=>{
 const now=Date.parse('2026-10-24T13:12:00-03:00'),input={clientId:'1',professionalId:'2',service:'7',date:'2026-10-24',start:'13:10'};
 assert.equal(bookingInput(input,{now,allowElapsedStart:true}).start,'13:10');
 assert.throws(()=>bookingInput(input,{now}),/início selecionado já passou/);
 assert.throws(()=>bookingInput({...input,date:'2026-10-23'},{now,allowElapsedStart:true}),/início selecionado já passou/);
 assert.equal(bookingInput({...input,start:'13:30'},{now}).start,'13:30');
});
test('connector signs tenant and body, does not follow redirects and fails closed when unconfigured',async()=>{
 const tenant=randomUUID(),secret='test-'.repeat(10),env={CASHBARBER_URL:'http://cashbarber:3200',CASHBARBER_SECRET:secret};
 const client=createCashbarberClient({env,fetcher:async(url,options)=>{assert.equal(url.pathname,'/v1/'+tenant+'/status');assert.equal(options.redirect,'error');assert.ok(validQrSignature(secret,'POST',url.pathname,new Headers(options.headers),options.body));assert.ok(!validQrSignature(secret,'POST','/v1/'+randomUUID()+'/status',new Headers(options.headers),options.body));return Response.json({connected:true});}});
 assert.equal((await client.forUser({id:randomUUID()}).call(tenant,'status')).connected,true);await assert.rejects(createCashbarberClient({env:{}}).call(tenant,'status'),e=>e.status===503);
});
test('PostgreSQL: conversation guards, tenant isolation, link validation, preview expiry, replay and uncertain write protection',async()=>{
 const db=new PGlite(),query=(sql,args=[])=>db.query(sql,args),pool={query,connect:async()=>({query,release(){}})};
 const tenant=randomUUID(),other=randomUUID(),uid=randomUUID(),cid=randomUUID(),account=randomUUID(),calls=[];
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await query("insert into tenants values($1,'Teste','5534999999999')",[tenant]);await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Ana','ana@test.invalid','none','admin')",[uid,tenant]);
  await query("insert into accounts(id,tenant,name,channel,secret) values($1,$2,'WhatsApp','whatsapp','{}')",[account,tenant]);
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5511999999999','Cliente','open',0,0,$4)",[cid,tenant,account,uid]);
  let commitState='confirmed';const client={configured:()=>true,call:async(t,action,input)=>{calls.push(action);if(action==='client')return {client:{id:input.id,name:'Cliente'}};if(action==='preview')return {available:true,quote:{...input,end:'14:50',price:0,duration:50}};if(action==='commit'){if(commitState==='timeout')throw Error('Timeout');return {state:commitState,externalId:'55'};}if(action==='reconcile')return {state:'confirmed',externalId:'56'};return {connected:true};}};
  const user={id:uid,tenant,name:'Ana',role:'admin'},conversation={id:cid,tenant,assigned_to:uid,status:'open'};
  const store=createCashbarber({pool,client,audit:async()=>{},getConversation:async(u,id)=>{if(u.tenant!==tenant||id!==cid)throw Object.assign(Error('Forbidden'),{status:403});return conversation;}});
  const call=(action,input={},u=user)=>store.route(u,'/api/cashbarber/'+action,{conversation:cid,...input});
  await assert.rejects(call('context',{}, {...user,tenant:other}),e=>e.status===403);await assert.rejects(call('link',{id:'1'},{...user,role:'viewer'}),e=>e.status===403);
  const details={professionalId:'2',service:'Manicure',date:new Date(Date.now()+86400000).toISOString().slice(0,10),start:'14:00'};
  await assert.rejects(call('week-day',{date:'2026-02-30'}),e=>e.status===400);
  await assert.rejects(call('week-day',{date:details.date},{...user,tenant:other}),e=>e.status===403);
  await call('week-day',{date:details.date},{...user,role:'viewer'});assert.ok(calls.includes('week-day'));
  await assert.rejects(call('preview',details),/Vincule/);await call('link',{id:'1'});assert.equal((await call('context')).link.client_id,'1');
  user.role='receptionist';await query("update users set role='receptionist' where id=$1",[uid]);
  const first=await call('preview',details);await call('commit',{id:first.id});await call('commit',{id:first.id});assert.equal(calls.filter(c=>c==='commit').length,1);
  const summary=await call('context');assert.equal(summary.confirmationBookings.length,1);assert.equal(summary.confirmationBookings[0].id,first.id);
  for(let i=0;i<16;i++)await query("insert into cashbarber_bookings(tenant,conversation,actor,state,quote,receipt,created,updated,expires) values($1,$2,$3,'confirmed',$4,$5,$6,$6,$6)",[tenant,cid,uid,JSON.stringify({...first.quote,service:'Serviço '+i}),JSON.stringify({externalId:String(100+i)}),Date.now()+i]);
  const allConfirmed=await call('context');assert.equal(allConfirmed.bookings.length,15);assert.equal(allConfirmed.confirmationBookings.length,17);assert.ok(allConfirmed.confirmationBookings.some(b=>b.id===first.id));

  const opportunities=(await query('select * from crm_opportunities where conversation=$1',[cid])).rows;assert.equal(opportunities.length,1);assert.equal(opportunities[0].owner,uid);
  const stale=await call('preview',details);await query('update cashbarber_bookings set expires=0 where id=$1',[stale.id]);await assert.rejects(call('commit',{id:stale.id}),e=>e.status===409);
  const relink=await call('preview',details);await call('link',{id:'3'});assert.equal((await call('context')).confirmationBookings.length,0);await assert.rejects(call('commit',{id:relink.id}),e=>e.status===409);
  commitState='timeout';const uncertain=await call('preview',details);assert.equal((await call('commit',{id:uncertain.id})).state,'uncertain');await assert.rejects(call('preview',details),e=>e.status===409);await assert.rejects(call('reconcile',{id:uncertain.id}),e=>e.status===409);await query('update cashbarber_bookings set updated=0 where id=$1',[uncertain.id]);assert.equal((await call('reconcile',{id:uncertain.id})).state,'confirmed');
  const manual=await call('preview',details);await call('commit',{id:manual.id});await assert.rejects(call('dismiss',{id:manual.id}),/Confirme/);await assert.rejects(call('dismiss',{id:manual.id,confirmedAbsent:true}),e=>e.status===409);await query('update cashbarber_bookings set updated=0 where id=$1',[manual.id]);assert.equal((await call('dismiss',{id:manual.id,confirmedAbsent:true})).state,'rejected');
  const oldTime=Date.parse('2026-09-01T14:00:00Z'),closureTime=Date.parse('2026-10-01T14:00:00Z'),newTime=Date.parse('2026-10-27T01:30:00Z');
  for(const created of [oldTime,newTime])await query("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in','Olá',$3,'received')",[randomUUID(),cid,created]);
  await query("insert into attendance_history(tenant,conversation,actor,actor_name,action,created) values($1,$2,$3,'Ana','Atendimento finalizado',$4)",[tenant,cid,uid,closureTime]);
  assert.equal((await call('closure')).attendance_date,'2026-10-26');
  await call('appointments',{client_id:'1',from:'2026-10-27',to:'2027-10-27'});assert.equal(calls.at(-1),'appointments');
  await assert.rejects(call('appointments',{client_id:'1',from:'2026-10-27',to:'2028-10-27'}),e=>e.status===400);
  conversation.assigned_to=null;await assert.rejects(call('preview',details),e=>e.status===403);assert.ok((await call('context')).bookings.length);
 }finally{await db.close();}
});
