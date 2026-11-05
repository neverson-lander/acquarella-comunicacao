import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createDailyActions} from '../lib/daily-actions.mjs';
import {subscriptionDue,subscriptionTargets,subscriptionText,oldComanda,scheduledAt} from '../lib/daily-actions-domain.mjs';
const at=x=>Date.parse(x+'-03:00');
test('calendar rules clamp month end, roll over year, and require strictly more than 72 hours',()=>{
 assert.equal(subscriptionDue('2027-02-28',31),'2027-02-28');assert.equal(subscriptionDue('2028-02-01',30),'2028-02-29');assert.equal(subscriptionDue('2026-11-04',0),null);
 assert.deepEqual(subscriptionTargets('2026-12-30'),[{day:'2026-12-30',notice:'due'},{day:'2027-01-02',notice:'advance'}]);
 assert.match(subscriptionText('2027-01-02'),/02\/01\/2027/);assert.match(subscriptionText('2027-01-02'),/55771128000140/);
 const now=at('2026-11-04T07:00:00'),r={com_pago:0,com_active:1,created_at:new Date(now-72*3600000).toISOString()};
 assert.equal(oldComanda(r,now),false);assert.equal(oldComanda(r,now+1),true);assert.equal(oldComanda({...r,com_pago:1},now+1),false);
 assert.equal(scheduledAt('2026-11-04','subscriptions'),at('2026-11-04T08:00:00'));
});
test('daily routines default off, enforce schedules, deduplicate subscriptions, isolate tenants and never repeat uncertain closes',async()=>{
 const db=new PGlite(),tenant=randomUUID(),account=randomUUID(),foreign=randomUUID(),user={tenant,role:'admin'};
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);for(const row of r.rows)for(const [k,v]of Object.entries(row))if(typeof v==='bigint')row[k]=Number(v);return r;};
 let time=at('2026-11-03T06:00:00'),sent=[],calls=[],closed=[],active=true,throwClose=false,manualPages=null;
 const client={configured:()=>true,call:async(t,action,input)=>{assert.equal(t,tenant);calls.push({action,input});
  if(action==='daily-comanda-options')return {boxes:[{id:'1',name:'Caixa'}],methods:[{id:'2',name:'Outros'}]};
  if(action==='daily-subscriptions')return {items:[{id:'11',name:'Cliente',plan:'9'},{id:'12',name:'Cliente',plan:'9'}]};
  if(action==='daily-subscriber')return {active,name:'Cliente',phone:'5534999998888'};
  if(action==='daily-comandas')return manualPages?{ids:manualPages[input.page],lastPage:manualPages.length}:{ids:['21','22'],lastPage:1};
  if(action==='daily-close-comanda'){closed.push(input.id);if(throwClose)throw Error('timeout');return {state:'closed'};}
  throw Error(action);
 }};
 const service=()=>createDailyActions({pool:{query},client,usesQr:a=>a.secret==='qr',now:()=>time,send:async(a,to,body,key)=>{sent.push({to,body,key});return 'ext-'+key;}});
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  for(const id of [tenant,foreign])await query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[id]);
  await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'WhatsApp','whatsapp','qr','live')",[account,tenant]);
  assert.ok((await service().settings(user)).settings.every(s=>s.enabled===false));
  const force={action:'run-comandas',confirm:true};
  await assert.rejects(service().settings(user,force),e=>e.status===409);
  await assert.rejects(service().settings({...user,role:'agent'},force),e=>e.status===403);
  await service().process();assert.equal(calls.length,0);
  await assert.rejects(service().settings({...user,role:'agent'}),e=>e.status===403);
  await assert.rejects(service().settings(user,{save:true,feature:'comandas',enabled:true,cashbox:'1',payment_method:'2'}));
  await assert.rejects(service().settings({tenant:foreign,role:'admin'},{save:true,feature:'subscriptions',enabled:true,account}));
  await service().settings(user,{save:true,feature:'subscriptions',enabled:true,account});
  await service().settings(user,{save:true,feature:'comandas',enabled:true,cashbox:'1',payment_method:'2',acknowledge:true});calls=[];
  time=at('2026-11-04T06:59:59');await service().process();assert.equal(calls.length,0);
  time+=1000;await service().process();assert.deepEqual(closed,[]);assert.equal(calls[0].action,'daily-comandas');
  time=at('2026-11-04T07:01:00');
  await service().process();assert.deepEqual([...closed].sort(),['21','22']);assert.equal(sent.length,0);
  time=at('2026-11-04T08:00:00');await service().process();
  time=at('2026-11-04T08:01:00');for(let i=0;i<8;i++)await service().process();
  assert.equal(sent.length,2);assert.notEqual(sent[0].key,sent[1].key);assert.ok(sent.some(s=>s.body.includes('04/11/2026')));assert.ok(sent.some(s=>s.body.includes('07/11/2026')));
  for(let i=0;i<3;i++)await service().process();assert.equal(sent.length,2);assert.equal(closed.length,2);
  assert.equal((await query('select count(*)::int as n from messages where attendance_relevant=false')).rows[0].n,2);
  // Late activation waits for tomorrow and disabling blocks all future work.
  await service().settings(user,{save:true,feature:'subscriptions',enabled:false,account});
  await service().settings(user,{save:true,feature:'subscriptions',enabled:true,account});
  await service().process();assert.equal(sent.length,2);
  time=at('2026-11-05T08:00:00');active=false;for(let i=0;i<5;i++)await service().process();assert.equal(sent.length,2);
  assert.equal((await query("select id from daily_action_runs where feature='comandas' and day='2026-11-05'")).rows.length,0);
  // A new command's timeout is persisted and never automatically retried.
  await query("delete from daily_action_items where external_id='22'");throwClose=true;
  time=at('2026-11-06T07:00:00');for(let i=0;i<5;i++)await service().process();
  assert.equal(closed.filter(x=>x==='22').length,2);
  assert.equal((await query("select state from daily_action_items where external_id='22'")).rows[0].state,'uncertain');
  time=at('2026-11-07T07:00:00');for(let i=0;i<4;i++)await service().process();assert.equal(closed.filter(x=>x==='22').length,2);
  // A manual run can scan again on the same day, without replaying financial writes.
  throwClose=false;manualPages=[['21','22','23']];
  time=at('2026-11-07T13:00:00');
  await assert.rejects(service().settings(user,{action:'run-comandas'}),/Confirme/);
  const repeated=await service().settings(user,force);
  assert.equal(repeated.runs.find(r=>r.day==='2026-11-07'&&r.feature==='comandas').state,'complete');
  assert.deepEqual(closed.slice(-1),['23']);assert.equal(closed.filter(x=>x==='22').length,2);
  // A manual start before 7h continues in the worker, without triggering subscriptions.
  time=at('2026-11-08T06:00:00');manualPages=[['24'],['25']];calls=[];
  const started=await service().settings(user,force);
  assert.equal(started.runs.find(r=>r.day==='2026-11-08'&&r.feature==='comandas').state,'discovering');
  assert.deepEqual(calls.map(c=>c.action),['daily-comandas']);
  await service().process();await service().process();
  assert.deepEqual(closed.slice(-2).sort(),['24','25']);
  assert.ok(!calls.some(c=>c.action==='daily-subscriptions'));
  time=at('2026-11-08T08:01:00');await service().process();
  assert.ok(!calls.some(c=>c.action==='daily-subscriptions'),'a missed start must not generate a late subscription batch');
 }finally{await db.close();}
});
