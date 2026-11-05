import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {notificationPlan,notificationText,localDate} from '../lib/appointment-notifications-domain.mjs';
import {createAppointmentNotifications} from '../lib/appointment-notifications.mjs';
const at=s=>Date.parse(s+'-03:00');
const booking={id:'1',clientId:'2',active:true,clientName:'Cliente',phone:'5534999998888',email:'cliente@test.invalid',professionalName:'Ana',services:[{id:'3',name:'Manicure'}],startsAt:at('2026-11-04T15:00:00'),createdAt:at('2026-11-02T10:00:00')};

test('welcoming templates include grace policy, correct date/time and same-day reminder wording',()=>{
  const current={...booking,clientName:'Iraci Abadia do Carmo Martins',startsAt:at('2026-11-03T09:50:00')};
  const confirmation=notificationText(current,'confirmation',at('2026-11-02T20:00:00'));
  assert.match(confirmation,/^Olá, Iraci! 💕/);assert.match(confirmation,/03\/11\/2026, às 09h50/);
  assert.match(confirmation,/10 minutinhos/);assert.match(confirmation,/reorganizado conforme a disponibilidade/);
  assert.ok(!confirmation.includes('Ana'));assert.ok(!confirmation.includes('2025'));
  const future=notificationText(current,'reminder',at('2026-11-02T23:59:59'));
  assert.match(future,/será no dia 03\/11\/2026, às 09h50/);assert.ok(!future.includes('hoje'));
  const today=notificationText(current,'reminder',at('2026-11-03T00:00:00'));
  assert.match(today,/será hoje, às 09h50/);assert.match(today,/10 minutinhos/);assert.match(today,/esperando você com carinho/);
  assert.match(notificationText(current,'confirmation',at('2026-11-03T08:00:00')),/agendado para hoje, às 09h50/);
});
test('rules use calendar dates in São Paulo, include exactly 24h, exclude same day and unknown creation',()=>{
  const kinds=(b={},now='2026-11-03T10:00:00')=>notificationPlan({...booking,...b},at(now)).map(p=>p.kind);
  assert.deepEqual(kinds({},'2026-11-02T10:00:00'),[]);
  assert.deepEqual(kinds({},'2026-11-04T10:00:00'),['reminder']);
  assert.deepEqual(kinds(),['confirmation']);
  assert.deepEqual(kinds({createdAt:at('2026-11-03T15:00:00')}),['confirmation']);
  assert.deepEqual(kinds({createdAt:at('2026-11-03T15:00:01')}),[]);
  assert.deepEqual(kinds({createdAt:at('2026-11-04T01:00:00')}),[]);
  assert.deepEqual(kinds({createdAt:null}),[]);assert.deepEqual(kinds({active:false}),[]);
  assert.deepEqual(kinds({bookedAt:at('2026-11-04T08:00:00')},'2026-11-04T10:00:00'),[]);
  assert.equal(localDate(Date.parse('2026-11-04T01:00:00Z')),'2026-11-03');
});
test('persistent worker sends independently of reply, revalidates, handles restart, tenant permissions and reschedules',async()=>{
  const db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
  const tenant=randomUUID(),foreign=randomUUID(),account=randomUUID(),otherAccount=randomUUID(),user={tenant,role:'admin'};
  let time=at('2026-11-03T15:00:00'),current={...booking},calls=[],agendaDates=[],sent=[],error=null,beforeDetails=null;
  const client={configured:()=>true,call:async(t,action,input)=>{
    assert.equal(t,tenant);calls.push(action);
    if(action==='notification-agenda'){
      agendaDates.push(input.date);
      return {ids:localDate(current.startsAt)===input.date&&current.active?[current.id]:[]};
    }
    if(beforeDetails){const hook=beforeDetails;beforeDetails=null;await hook();}
    return structuredClone(current);
  }};
  const service=()=>createAppointmentNotifications({pool:{query,connect:async()=>({query,release(){}})},client,usesQr:a=>a.secret==='qr',now:()=>time,send:async(a,to,body,key)=>{sent.push({to,body,key});if(error)throw error;return 'external-'+sent.length;}});
  try{
    for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
    for(const id of [tenant,foreign])await query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[id]);
    for(const [id,t]of [[account,tenant],[otherAccount,foreign]])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Agenda','whatsapp','qr','live')",[id,t]);
    await assert.rejects(service().settings({...user,role:'receptionist'}),e=>e.status===403);
    await assert.rejects(service().connection({...user,role:'agent'},{action:'login'}),e=>e.status===403);
    await assert.rejects(service().connection(user,{action:'commit'}),e=>e.status===400);
    await assert.rejects(service().settings(user,{save:true,enabled:true,account:otherAccount}),e=>e.status===400);
    const originalConversation=randomUUID();await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,'Cliente','open',$5,$5)",[originalConversation,tenant,account,booking.phone.slice(0,4)+booking.phone.slice(5),time-1000]);
    await service().settings(user,{save:true,enabled:true,account});
    assert.equal((await service().settings(user)).settings.delivery_mode,'manual');
    await service().process();assert.equal(sent.length,0);
    await assert.rejects(service().settings(user,{save:true,enabled:true,account,delivery_mode:'invalid'}),e=>e.status===400);
    await assert.rejects(service().settings(user,{save:true,enabled:false,account,delivery_mode:'automatic'}),e=>e.status===400);
    await assert.rejects(service().settings({...user,role:'receptionist'},{save:true,enabled:true,account,delivery_mode:'automatic'}),e=>e.status===403);
    await service().settings(user,{save:true,enabled:true,account,delivery_mode:'automatic'});
    // Turning off while the worker reads the agenda invalidates its permission to send.
    beforeDetails=()=>service().settings(user,{save:true,enabled:true,account,delivery_mode:'manual'});
    await service().process();assert.equal(sent.length,0);
    assert.equal((await service().settings(user)).settings.delivery_mode,'manual');
    await service().settings(user,{save:true,enabled:true,account,delivery_mode:'automatic'});
    await service().process();assert.equal(sent.length,1);assert.match(sent[0].body,/está agendado/);
    assert.equal((await query('select conversation from messages')).rows[0].conversation,originalConversation,'automatic message must be saved in the established legacy-phone conversation');assert.equal((await query('select count(*) as total from conversations where tenant=$1',[tenant])).rows[0].total,1);
    assert.equal((await query("select * from appointment_notifications where kind='reminder'")).rows.length,0,'tomorrow has no reminder draft');
    const contact=(await query('select * from crm_contacts where tenant=$1 and account=$2',[tenant,account])).rows[0];assert.equal(contact.name,'Cliente');assert.equal(contact.email,'cliente@test.invalid');
    await query("update crm_contacts set name='Nome editado',name_manual=true,email='manual@test.invalid' where id=$1",[contact.id]);
    await service().process();assert.equal(sent.length,1,'restart does not send confirmation twice');
    const preserved=(await query('select * from crm_contacts where id=$1',[contact.id])).rows[0];assert.equal(preserved.name,'Nome editado');assert.equal(preserved.email,'manual@test.invalid');assert.equal((await query('select * from crm_contacts where tenant=$1',[tenant])).rows.length,1);
    time=at('2026-11-04T13:00:00');await service().process();assert.equal(sent.length,2);assert.match(sent[1].body,/será hoje, às 15h00/);
    assert.equal((await query("select * from messages where state='sent'")).rows.length,2);
    // A same-day booking receives neither message.
    current={...booking,id:'2',createdAt:at('2026-11-04T09:00:00')};await service().process();assert.equal(sent.length,2);
    current={...booking,id:'3',phone:'5534999997777',createdAt:at('2026-11-03T18:00:00')};await service().process();assert.equal(sent.length,3);
    assert.equal((await query("select * from appointment_notifications where external_id='3' and kind='confirmation'")).rows.length,0);
    // Observe a future reservation, then cancel before the confirmation is due.
    current={...booking,id:'4',startsAt:at('2026-11-05T15:00:00')};await service().process();
    time=at('2026-11-04T15:00:00');current.active=false;await service().process();assert.equal(sent.length,3);
    assert.deepEqual((await query("select state from appointment_notifications where external_id='4'")).rows,[{state:'cancelled'}]);
    // Changing the date on the day of service cancels the old notification schedule.
    current={...booking,id:'5',startsAt:at('2026-11-05T18:00:00')};await service().process();
    current.startsAt=at('2026-11-04T18:00:00');await service().process();assert.equal(sent.length,3);
    // A timeout is uncertain and never automatically retried.
    time=at('2026-11-05T13:00:00');current={...booking,id:'6',startsAt:at('2026-11-05T15:00:00')};error=Error('Timeout');await service().process();assert.equal(sent.length,4);
    error=null;await service().process();assert.equal(sent.length,4);
    assert.equal((await query("select state from appointment_notifications where external_id='6' and kind='reminder'")).rows[0].state,'uncertain');
    // An interrupted sending record is recovered conservatively on restart.
    await query("update appointment_notifications set state='sending',updated=0 where external_id='6' and kind='reminder'");await service().process();assert.equal(sent.length,4);
    assert.equal((await query("select state from appointment_notifications where external_id='6' and kind='reminder'")).rows[0].state,'uncertain');
    // Expired notifications do not catch up hours later.
    current={...booking,id:'7',startsAt:at('2026-11-05T14:00:00')};await service().process();assert.equal(sent.length,4);
    // A confirmation already queued must be checked by ID if its booking leaves the window.
    current={...booking,id:'8',startsAt:at('2026-11-06T15:00:00')};await service().process();
    current.startsAt=at('2026-11-15T15:00:00');time=at('2026-11-05T15:00:00');agendaDates=[];
    await service().process();
    assert.deepEqual(agendaDates,['2026-11-05','2026-11-06']);
    assert.deepEqual((await query("select state from appointment_notifications where external_id='8'")).rows,[{state:'cancelled'}]);
    assert.equal(sent.length,4);
    await service().settings(user,{save:true,enabled:false,account});const before=calls.length;await service().process();assert.equal(calls.length,before);
    assert.equal((await service().settings(user)).settings.delivery_mode,'manual');
    assert.equal((await service().settings(user)).history.some(j=>j.state==='expired'),true);
    assert.equal((await query("select relrowsecurity from pg_class where relname='appointment_notifications'")).rows[0].relrowsecurity,true);
  }finally{await db.close();}
});
