import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {createCrm} from '../lib/crm-store.mjs';
import {createWaitingAlerts} from '../lib/waiting-alerts.mjs';
import {instagramMessageType} from '../lib/instagram-attendance.mjs';
import {repairInstagramAttendance} from '../lib/instagram-attendance-repair.mjs';
import {queueWaitingSince,createMessageObserver} from '../public/inbox-domain.mjs';
import {realOpportunity,selectedTouch} from '../public/crm-domain.mjs';

test('Instagram distinguishes typed DMs from shares, mentions and story reactions before media normalization',()=>{
 for(const type of ['share','ig_post','ig_reel','reel','story_mention','ephemeral'])assert.equal(instagramMessageType({text:'Automatic text',attachments:[{type}]}),'social');
 assert.equal(instagramMessageType({text:'😍',reply_to:{story:{id:'story'}}}),'social');
 assert.equal(instagramMessageType({text:'Qual o valor?',reply_to:{story:{id:'story'}}}),'text');
 assert.equal(instagramMessageType({attachments:[{type:'audio'}]}),'media');
 assert.equal(instagramMessageType({text:'   '}),'social');
 assert.equal(instagramMessageType({text:'Olá'}),'text');
});

test('Instagram keeps social history without queue, CRM, alerts or reopen; text starts service and active media counts',async()=>{
 const db=new PGlite(),tenant=randomUUID(),aid=randomUUID(),waid=randomUUID();let time=Date.now()-3600000;
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},one=async(sql,args)=>(await query(sql,args)).rows[0],pool={query,connect:async()=>({query,release(){}})};
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await query("insert into tenants(id,name,phone) values($1,'Test','5534999999999')",[tenant]);
  await query("insert into accounts(id,tenant,name,channel,external,secret,mode,bridge,forwarding_enabled,alerts_enabled,alerts_phones,queue_alert_minutes) values($1,$2,'IG','instagram','ig','{}','live',$3,true,true,'[\"5534999999999\"]',5),($3,$2,'WA','whatsapp','wa','{}','live',null,false,false,'[]',5)",[aid,tenant,waid]);
  await query('insert into bridge_windows(account,phone,seen) values($1,$2,$3)',[waid,'5534999999999',time]);
  const crm=createCrm({pool,open:JSON.parse,seal:JSON.stringify,permitted:()=>true,now:()=>time}),forwarded=[],alerts=[];
  const handler=createInboundHandler({one,run:query,id:randomUUID,now:()=>time,open:JSON.parse,profile:async()=>({name:'Maria'}),send:async()=>{},queue:async(...a)=>forwarded.push(a),audit:async()=>{},capture:crm.capture,captureReferral:crm.captureReferral});
  const worker=createWaitingAlerts({pool,now:()=>time,send:async(a,to,body)=>{alerts.push(body);return randomUUID();}}),account=await one('select * from accounts where id=$1',[aid]);
  const payload=(mid,message,customer='customer')=>({entry:[{id:'ig',messaging:[{sender:{id:customer},timestamp:time,message:{mid,...message}}]}]});
  const receive=async(mid,message,customer)=>{const p=payload(mid,message,customer);await handler(account,p);return p;};
  const snapshot=async()=>{const c=await one("select * from conversations where customer='customer'");return {...c,messages:(await query('select * from messages where conversation=$1 order by created',[c.id])).rows};};
  const mention=await receive('mention',{attachments:[{type:'story_mention',payload:{url:'https://cdninstagram.com/story'}}]});
  let c=await snapshot();assert.equal(c.attendance_eligible,false);assert.equal(c.messages[0].attendance_relevant,false);assert.equal(queueWaitingSince(c),null);assert.equal(forwarded.length,0);assert.equal((await one('select count(*) as n from crm_opportunities')).n,0);
  time+=600000;assert.equal((await worker()).sent,0);
  const observer=createMessageObserver(),snap=c=>({tenant:{id:tenant},user:{id:'operator'},conversations:[c],server_time:time});observer.observe(snap(c));
  await receive('photo',{attachments:[{type:'image',payload:{url:'https://cdninstagram.com/photo'}}]});assert.equal(observer.observe(snap(await snapshot())).length,0);
  time+=600000;const firstText=time;await receive('text',{text:'Quero agendar'});c=await snapshot();assert.equal(c.attendance_eligible,true);assert.equal(queueWaitingSince(c),firstText);assert.equal(observer.observe(snap(c)).length,1);assert.equal(forwarded.length,1);
  const opportunity=await one('select * from crm_opportunities where conversation=$1',[c.id]);assert.equal(Number(opportunity.first_contact),firstText);
  time+=300000;assert.equal((await worker()).sent,1);assert.ok(alerts[0].includes('Maria'));
  await query("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'out','Respondido',$3,'sent')",[randomUUID(),c.id,time]);
  time+=1000;await receive('share',{attachments:[{type:'share',payload:{url:'https://instagram.com/p/share'}}]});assert.equal(queueWaitingSince(await snapshot()),null);
  time+=1000;await receive('audio',{attachments:[{type:'audio',payload:{url:'https://cdninstagram.com/audio'}}]});assert.equal(queueWaitingSince(await snapshot()),time);
  await query("update conversations set status='resolved' where id=$1",[c.id]);time+=1000;await receive('closed-mention',{attachments:[{type:'story_mention',payload:{url:'https://cdninstagram.com/story'}}]});assert.equal((await snapshot()).status,'resolved');
  await receive('closed-audio',{attachments:[{type:'audio',payload:{url:'https://cdninstagram.com/audio'}}]});assert.equal((await snapshot()).status,'resolved');
  time+=1000;await receive('return',{text:'Olá novamente'});assert.equal((await snapshot()).status,'open');assert.equal((await one("select count(*) as n from attendance_history where conversation=$1 and action like 'Nova mensagem%'",[c.id])).n,1);
  const legacy=await receive('legacy',{attachments:[{type:'share',payload:{url:'https://instagram.com/p/legacy'}}]},'legacy');
  await query("update conversations set attendance_eligible=true where customer='legacy'");await query("update messages set attendance_relevant=true where external=$1",[aid+':legacy']);
  await query("insert into events(id,tenant,payload,state,created) values($1,$2,$3,'done',$4)",[randomUUID(),tenant,JSON.stringify(legacy),time]);
  const legacyConversation=await one("select * from conversations where customer='legacy'");await crm.capture(legacyConversation,account,{customer:'legacy',external:'legacy',timestamp:time,body:'[Anexo recebido]'});
  const repaired=await repairInstagramAttendance({query},tenant,JSON.parse);assert.equal(repaired.interactions,1);assert.equal((await one("select attendance_eligible from conversations where customer='legacy'")).attendance_eligible,false);
  assert.equal((await repairInstagramAttendance({query},tenant,JSON.parse)).interactions,0);assert.equal(realOpportunity({mode:'live',attendance_eligible:false}),false);
  time+=1000;await receive('legacy-text',{text:'Quero saber o valor',referral:{source:'ADS',ad_id:'123456'}},'legacy');
  const legacyTouches=(await query('select t.* from crm_touches t join crm_opportunities o on o.id=t.opportunity where o.conversation=$1',[legacyConversation.id])).rows;
  assert.equal(legacyTouches.find(t=>t.event_key==='legacy').ignored_for_attribution,true);assert.equal(selectedTouch({touches:legacyTouches}).ad_id,'123456');assert.equal(legacyTouches.length,2);
  assert.equal((await one("select count(*) as n from messages where external=$1",[aid+':legacy'])).n,1);
 }finally{await db.close();}
});
