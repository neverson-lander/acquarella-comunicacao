import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';import {readFile,readdir} from 'node:fs/promises';
import {createAppointmentNotifications} from '../lib/appointment-notifications.mjs';import {createActiveMessageManagement} from '../lib/active-message-management.mjs';import {notificationText,notificationPlan,allowedMessageTime} from '../lib/appointment-notifications-domain.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
const at=v=>Date.parse(v+'-03:00');
test('migration updates unsent legacy drafts and morning due time without rewriting delivery history',async()=>{
 const db=new PGlite();try{
  await db.exec('create table users(id uuid primary key);create table appointment_notification_settings(tenant uuid);create table appointment_notifications(id uuid,tenant uuid,kind text,due bigint,state text,body text);');
  const body='Olá, Maria da Silva!\nLembrete do seu agendamento na Acquarella:\n04/11/2026, 09:00 · Isaura Oliveira\nManicure\nResponda por aqui.';
  for(const state of ['pending','sent'])await db.query('insert into appointment_notifications values($1,$2,$3,$4,$5,$6)',[randomUUID(),randomUUID(),'reminder',at('2026-11-04T07:00:00'),state,body]);
  await db.exec(await readFile(new URL('../supabase/migrations/20261103002510_active_message_management.sql',import.meta.url),'utf8'));
  const rows=(await db.query('select * from appointment_notifications')).rows,pending=rows.find(j=>j.state==='pending'),sent=rows.find(j=>j.state==='sent');
  assert.equal(Number(pending.due),at('2026-11-04T08:00:00'));assert.equal(Number(pending.starts_at),at('2026-11-04T09:00:00'));assert.equal(pending.professional_name,'Isaura Oliveira');assert.match(pending.body,/^Olá, Maria!/);assert.ok(!pending.body.includes('Isaura'));assert.equal(sent.body,body);
 }finally{await db.close();}
});
test('texts use only the first name, omit the professional, and morning schedules defer to 08:00',()=>{
 const booking={clientName:'  Maria da Silva  ',professionalName:'Isaura',startsAt:at('2026-11-04T09:00:00'),createdAt:at('2026-11-02T09:00:00'),active:true,services:[{name:'Manicure'}]};
 const text=notificationText(booking,'reminder');assert.match(text,/^Olá, Maria!/);assert.ok(!text.includes('Silva'));assert.ok(!text.includes('Isaura'));
 const reminder=notificationPlan(booking,at('2026-11-04T07:00:00')).find(p=>p.kind==='reminder');assert.equal(reminder.due,at('2026-11-04T08:00:00'));
 assert.equal(allowedMessageTime(at('2026-11-04T07:59:59')),false);assert.equal(allowedMessageTime(at('2026-11-04T08:00:00')),true);
});
test('manual-only operation, fresh previews, concurrent sending, permissions, filters and persistent cancellation',async()=>{
 const db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},pool={query,connect:async()=>({query,release(){}})};
 const tenant=randomUUID(),other=randomUUID(),account=randomUUID(),foreign=randomUUID(),uid=randomUUID(),user={tenant,id:uid,role:'admin',name:'Equipe'};let time=at('2026-11-03T10:00:00'),sent=0;
 let booking={id:'1',active:true,clientId:'2',clientName:'Maria da Silva',phone:'5534999998888',email:'maria@test.invalid',professionalName:'Isaura',startsAt:at('2026-11-04T10:00:00'),createdAt:at('2026-11-02T09:00:00'),services:[{id:'3',name:'Manicure'}]};
 const client={configured:()=>true,call:async(_t,action)=>action==='notification-agenda'?{ids:[booking.id]}:structuredClone(booking)};
 const service=createAppointmentNotifications({pool,client,now:()=>time,usesQr:()=>true,send:async()=>{sent++;return 'external-'+sent;}}),manage=createActiveMessageManagement({pool,now:()=>time});
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  for(const id of [tenant,other])await query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[id]);
  for(const [id,t]of [[account,tenant],[foreign,other]])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Agenda','whatsapp','qr','live')",[id,t]);
  await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Equipe','manual@test.invalid','unused','admin')",[uid,tenant]);
  await service.settings(user,{save:true,enabled:true,account});await service.process();assert.equal(sent,0,'manual mode must not send due messages automatically');
  let list=await manage.route(user,{state:'pending',professional:'Isaura',search:'Maria',from:'2026-11-03',to:'2026-11-04'});assert.equal(list.total,1);assert.equal(list.items[0].professional_name,'Isaura');
  const job=list.items.find(j=>j.kind==='confirmation'),record=await manage.record(user,job.id),preview=await service.manual(user,{action:'preview-send'},record);
  assert.match(preview.body,/Olá, Maria!/);assert.ok(!preview.body.includes('Isaura'));assert.equal(sent,0);
  time=at('2026-11-03T07:59:59');await assert.rejects(service.manual(user,{action:'send',confirm:true,fingerprint:preview.fingerprint},record),/8h/);assert.equal(sent,0);
  time=at('2026-11-03T08:00:00');await assert.rejects(service.manual(user,{action:'send',confirm:true,fingerprint:'stale'},record),/prévia/);
  const results=await Promise.allSettled([service.manual(user,{action:'send',confirm:true,fingerprint:preview.fingerprint},record),service.manual(user,{action:'send',confirm:true,fingerprint:preview.fingerprint},record)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(sent,1);
  assert.equal((await manage.route(user,{state:'sent'})).total,1);
  await assert.rejects(manage.route({...user,role:'viewer'}),e=>e.status===403);
  await assert.rejects(manage.record({...user,tenant:other},job.id),e=>e.status===404);
  assert.equal((await manage.route({...user,role:'receptionist',accounts:[]})).total,0);
  await assert.rejects(manage.route(user,{action:'cancel',id:job.id}),e=>e.status===409);
  time=at('2026-11-04T08:00:00');await service.process();
  const reminder=(await manage.route(user,{state:'pending',kind:'reminder'})).items[0];await manage.route(user,{action:'cancel',id:reminder.id});
  booking.professionalName='Bia';await service.process();assert.equal((await manage.route(user,{state:'pending'})).total,0,'professional changes must not recreate cancelled messages or resend sent ones');assert.equal(sent,1);
  booking={...booking,id:'2'};await service.process();assert.equal((await manage.route(user,{state:'pending',professional:'Bia'})).total,1);
  await assert.rejects(manage.route(user,{action:'cancel-all'}),/Confirme/);assert.equal((await manage.route(user,{action:'cancel-all',confirm:true})).cancelled,1);await service.process();assert.equal((await manage.route(user,{state:'pending'})).total,0);
  assert.equal((await manage.route(user,{state:'cancelled'})).total,2);assert.equal(sent,1);
  // Before-08:00 reminder is deferred; early appointments do not receive it after they start.
  booking={...booking,id:'3',startsAt:at('2026-11-04T07:30:00')};time=at('2026-11-04T07:00:00');await service.process();assert.equal(sent,1);time=at('2026-11-04T08:00:00');await service.process();assert.equal(sent,1);assert.ok((await manage.route(user,{state:'expired'})).total>0);
  const outgoing=(await query("select m.id,m.body,c.id as conversation,c.status,c.assigned_to from messages m join conversations c on c.id=m.conversation where m.direction='out'")).rows[0];
  assert.ok(outgoing.body.includes('10 minutinhos'));assert.equal(outgoing.status,'resolved');assert.equal(outgoing.assigned_to,null);
  const sender=(await query('select * from accounts where id=$1',[account])).rows[0];
  const inbound=createInboundHandler({one:async(sql,args)=>(await query(sql,args)).rows[0],run:query,id:randomUUID,now:()=>time,profile:async()=>({}),queue:async()=>{throw Error('No forwarding expected');}});
  await inbound(sender,{entry:[{changes:[{value:{metadata:{phone_number_id:sender.external},contacts:[{wa_id:booking.phone,profile:{name:booking.clientName}}],messages:[{id:'reply-to-active',from:booking.phone.slice(0,4)+booking.phone.slice(5),timestamp:String(time/1000),type:'text',text:{body:'Obrigada, confirmado!'}}]}}]}]});
  const reopened=(await query('select status,assigned_to from conversations where id=$1',[outgoing.conversation])).rows[0];assert.equal(reopened.status,'open');assert.equal(reopened.assigned_to,null);assert.equal((await query('select count(*) as total from conversations where tenant=$1',[tenant])).rows[0].total,1,'legacy WhatsApp reply must reuse the notification conversation');
  assert.equal((await query('select body from messages where id=$1',[outgoing.id])).rows[0].body,outgoing.body,'active outgoing remains visible after the reply reopens the conversation');
 }finally{await db.close();}
});


test('close expired messages individually and in bulk preserves history and tenant/channel scope',async()=>{
 const db=new PGlite(),pool={query:(sql,args=[])=>db.query(sql,args)};
 const tenant=randomUUID(),other=randomUUID(),account=randomUUID(),restricted=randomUUID(),foreign=randomUUID(),uid=randomUUID();
 const user={tenant,id:uid,role:'admin'},receptionist={...user,role:'receptionist',accounts:[account]},manage=createActiveMessageManagement({pool,now:()=>123456});
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  for(const id of [tenant,other])await db.query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[id]);
  for(const [id,t]of [[account,tenant],[restricted,tenant],[foreign,other]])await db.query("insert into accounts(id,tenant,name,channel,secret) values($1,$2,'Agenda','whatsapp','qr')",[id,t]);
  await db.query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Equipe','close@test.invalid','unused','admin')",[uid,tenant]);
  const ids=[];for(const [a,t,state]of [[account,tenant,'expired'],[account,tenant,'expired'],[restricted,tenant,'expired'],[foreign,other,'expired'],[account,tenant,'pending'],[account,tenant,'sent'],[account,tenant,'uncertain'],[account,tenant,'sending']]){
   const id=randomUUID();ids.push(id);await db.query("insert into appointment_notifications(id,tenant,account,external_id,revision,kind,due,state,body,updated) values($1,$2,$3,$5,'v1','reminder',1,$4,'Original message',1)",[id,t,a,state,id]);
  }
  await assert.rejects(manage.route(user,{action:'close-all-expired'}),/Confirme/);
  await assert.rejects(manage.route({...user,role:'viewer'},{action:'close-all-expired',confirm:true}),e=>e.status===403);
  await assert.rejects(manage.route(receptionist,{action:'close-expired',id:ids[2]}),e=>e.status===409);
  await assert.rejects(manage.route(user,{action:'close-expired',id:ids[3]}),e=>e.status===409);
  for(const id of ids.slice(4))await assert.rejects(manage.route(user,{action:'close-expired',id}),e=>e.status===409);
  assert.equal((await manage.route(receptionist,{action:'close-expired',id:ids[0]})).closed,1);
  await assert.rejects(manage.route(user,{action:'close-expired',id:ids[0]}),e=>e.status===409);
  assert.equal((await manage.route(receptionist,{action:'close-all-expired',confirm:true,search:'outside current filters'})).closed,1);
  assert.equal((await manage.route(receptionist,{action:'close-all-expired',confirm:true})).closed,0);
  const rows=(await db.query('select * from appointment_notifications')).rows;
  for(const id of ids.slice(0,2)){const row=rows.find(r=>r.id===id);assert.equal(row.state,'cancelled');assert.equal(row.cancelled_by,uid);assert.equal(Number(row.updated),123456);assert.equal(row.body,'Original message');assert.match(row.error,/encerrada/);}
  assert.equal(rows.find(r=>r.id===ids[2]).state,'expired');assert.equal(rows.find(r=>r.id===ids[3]).state,'expired');
  assert.deepEqual(ids.slice(4).map(id=>rows.find(r=>r.id===id).state),['pending','sent','uncertain','sending']);
  assert.equal((await manage.route(user,{action:'close-all-expired',confirm:true})).closed,1);
 }finally{await db.close();}
});
