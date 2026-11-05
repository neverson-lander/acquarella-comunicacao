import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createAppointmentNotifications} from '../lib/appointment-notifications.mjs';
import {localDate} from '../lib/appointment-notifications-domain.mjs';

const at=value=>Date.parse(value+'-03:00');
const base={id:'1',clientId:'2',active:true,clientName:'Maria Silva',phone:'5534999998888',professionalName:'Ana',services:[{id:'3',name:'Manicure'}],startsAt:at('2026-11-04T10:50:00'),createdAt:at('2026-11-02T09:00:00')};
async function fixture(){
  const db=new PGlite(),tenant=randomUUID(),account=randomUUID(),sent=[];
  const query=(sql,args=[])=>db.query(sql,args);
  // PGlite has one connection: serialize transactions like a real pooled connection.
  let tail=Promise.resolve();
  const pool={query,connect:async()=>{const previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});await previous;return {query,release};}};
  const state={time:at('2026-11-03T10:50:00'),bookings:[{...base}],metadata:true,error:null};
  const client={configured:()=>true,call:async(_tenant,action,input)=>{
    assert.equal(_tenant,tenant);
    if(action==='notification-appointment')return structuredClone(state.bookings.find(b=>b.id===input.id)||{id:input.id,active:false});
    assert.equal(action,'notification-agenda');
    const rows=state.bookings.filter(b=>localDate(b.startsAt)===input.date);
    return {ids:rows.map(b=>b.id),...(state.metadata?{groups:rows.map(b=>({id:b.id,clientId:b.clientId,date:localDate(b.startsAt)}))}:{})};
  }};
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[tenant]);
  await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Agenda','whatsapp','qr','live')",[account,tenant]);
  const service=createAppointmentNotifications({pool,client,usesQr:()=>true,now:()=>state.time,send:async(_sender,to,body,key)=>{sent.push({to,body,key});if(state.error)throw state.error;return 'sent-'+sent.length;}});
  const user={tenant,role:'admin',name:'Equipe',id:null};
  const configure=mode=>service.settings(user,{save:true,enabled:true,account,delivery_mode:mode});
  return {db,query,state,sent,service,user,configure,tenant,account};
}

test('same-day services use one confirmation and one reminder, with all distinct hours, across batches/restarts',async()=>{
  const f=await fixture();try{
    // Siblings extend beyond the worker's 12-ID page, with repeated hours.
    f.state.bookings=Array.from({length:14},(_,i)=>({...base,id:String(i+1),startsAt:i===13?at('2026-11-04T15:30:00'):base.startsAt}));
    f.state.bookings.push({...base,id:'20',clientId:'9',phone:'5534999997777'});
    await f.configure('automatic');await f.service.process();
    assert.equal(f.sent.length,2,'one message per customer');
    assert.match(f.sent.find(m=>m.to===base.phone).body,/às 10h50 e 15h30!/);
    assert.equal((f.sent[0].body.match(/10h50/g)||[]).length,1);
    await f.service.process();assert.equal(f.sent.length,2);
    f.state.time=at('2026-11-04T08:50:00');await f.service.process();await f.service.process();assert.equal(f.sent.length,4);
    assert.match(f.sent.findLast(m=>m.to===base.phone).body,/será hoje, às 10h50 e 15h30!/);
    f.state.time=at('2026-11-04T13:30:00');await f.service.process();assert.equal(f.sent.length,4,'later service must not send a second reminder');
  }finally{await f.db.close();}
});

test('legacy queued duplicates and uncertain deliveries are respected, including legacy phone identity',async()=>{
  const f=await fixture();try{
    f.state.metadata=false; // Safe fallback for older connector responses.
    f.state.bookings=[{...base},{...base,id:'2',startsAt:at('2026-11-04T11:50:00')}];
    await f.configure('manual');await f.service.process();
    await f.query("insert into appointment_notifications(id,tenant,account,external_id,revision,kind,due,state,body,updated,recipient,starts_at) values($1,$2,$3,'legacy','v1','confirmation',$4,'uncertain','Legacy',1,$5,$6)",[randomUUID(),f.tenant,f.account,f.state.time,base.phone.slice(0,4)+base.phone.slice(5),base.startsAt]);
    await f.configure('automatic');await f.service.process();assert.equal(f.sent.length,0);
    f.state.time=at('2026-11-04T08:00:00');await f.configure('manual');await f.service.process();
    const job=(await f.query("select * from appointment_notifications where kind='reminder'")).rows[0];
    const duplicate={...job,id:randomUUID(),external_id:'2',starts_at:at('2026-11-04T11:50:00')};
    await f.query("insert into appointment_notifications(id,tenant,account,external_id,revision,kind,due,state,body,updated,recipient,starts_at) values($1,$2,$3,$4,'v1','reminder',$5,'pending','Old draft',1,$6,$7)",[duplicate.id,f.tenant,f.account,'2',job.due,base.phone,at('2026-11-04T11:50:00')]);
    await f.configure('manual');
    const previews=await Promise.all([job,duplicate].map(j=>f.service.manual(f.user,{action:'preview-send'},j)));
    for(const preview of previews)assert.match(preview.body,/10h50 e 11h50/);
    const results=await Promise.allSettled([job,duplicate].map((j,i)=>f.service.manual(f.user,{action:'send',confirm:true,fingerprint:previews[i].fingerprint},j)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sent.length,1);
    await f.service.process();assert.equal(f.sent.length,1);
  }finally{await f.db.close();}
});

test('manual review detects sibling changes and removes cancelled services from the consolidated message',async()=>{
  const f=await fixture();try{
    f.state.bookings=[{...base},{...base,id:'2',startsAt:at('2026-11-04T11:50:00')}];
    await f.configure('manual');await f.service.process();
    const job=(await f.query("select * from appointment_notifications where kind='confirmation'")).rows[0];
    const preview=await f.service.manual(f.user,{action:'preview-send'},job);
    f.state.bookings[1].active=false;
    await assert.rejects(f.service.manual(f.user,{action:'send',confirm:true,fingerprint:preview.fingerprint},job),/prévia/);
    const fresh=await f.service.manual(f.user,{action:'preview-send'},job);assert.ok(!fresh.body.includes('11h50'));
    await f.service.manual(f.user,{action:'send',confirm:true,fingerprint:fresh.fingerprint},job);assert.equal(f.sent.length,1);
    // The following day's appointments still have their own messages.
    f.state.bookings=[{...base,id:'3',startsAt:at('2026-11-05T10:50:00')}];
    f.state.time=at('2026-11-04T10:50:00');await f.configure('automatic');await f.service.process();assert.equal(f.sent.length,2);
  }finally{await f.db.close();}
});

test('cancelling the first service lets a previously grouped legacy draft represent the remaining service',async()=>{
  const f=await fixture();try{
    f.state.bookings=[{...base},{...base,id:'2',startsAt:at('2026-11-04T11:50:00')}];
    await f.configure('manual');await f.service.process();
    await f.query("insert into appointment_notifications(id,tenant,account,external_id,revision,kind,due,state,body,updated,recipient,starts_at) values($1,$2,$3,'2','old','confirmation',$4,'pending','Old',1,$5,$6)",[randomUUID(),f.tenant,f.account,at('2026-11-03T11:50:00'),base.phone,at('2026-11-04T11:50:00')]);
    await f.service.process();
    assert.equal((await f.query("select state from appointment_notifications where external_id='2'")).rows[0].state,'cancelled');
    f.state.bookings[0].active=false;f.state.time=at('2026-11-03T11:50:00');
    await f.configure('automatic');await f.service.process();
    assert.equal(f.sent.length,1);assert.match(f.sent[0].body,/às 11h50!/);assert.ok(!f.sent[0].body.includes('10h50'));
  }finally{await f.db.close();}
});
