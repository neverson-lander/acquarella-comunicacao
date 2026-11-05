import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';

test('appearance is isolated per user; inbox uses bounded queries; attendance returns focused updates',async()=>{
 const db=new PGlite(),stamp=Date.now(),originalFetch=globalThis.fetch,calls=[],queries=[];
 const query=async(sql,args=[])=>{queries.push(sql);const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 try{
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  const tenant=randomUUID(),otherTenant=randomUUID(),aid=randomUUID(),cid=randomUUID(),key=randomBytes(32),users={};
  const seal=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');};
  await query("insert into tenants(id,name,phone) values($1,'Test','5534999999999'),($2,'Other','5534888888888')",[tenant,otherTenant]);
  for(const role of ['admin','agent','receptionist','viewer','noAccount','foreign']){
   const id=randomUUID();users[role]=id;await query('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[id,role==='foreign'?otherTenant:tenant,role==='agent'?'Beatriz':role==='admin'?'Administrador':role,role+'@test.invalid','unused',['noAccount','foreign'].includes(role)?'agent':role,JSON.stringify(role==='noAccount'?[]:[aid])]);
   await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(role).digest('hex'),id,stamp+3600000]);
  }
  await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'Instagram','instagram','1784',$3,'live')",[aid,tenant,seal({token:'TEST_TOKEN',instagramApiId:'1234'})]);
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'customer','Cliente','open',$4,$4,$5)",[cid,tenant,aid,stamp,users.agent]);
  globalThis.__acquarellaPool={query,connect:async()=>({query,release(){}})};process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.PUBLIC_ORIGIN='https://test.invalid';
  const {default:app}=await import('../api/index.mjs');globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({message_id:'test-'+calls.length}),{status:200});};
  const api=(path,body,role='admin')=>app.fetch(new Request('https://test.invalid/api/'+path,{method:'POST',headers:{cookie:'session='+role,'content-type':'application/json'},body:JSON.stringify(body)}));
  const reply=(body,role='admin')=>api('conversations/'+cid+'/reply',body,role);

  const state=async(role='admin')=>{const response=await app.fetch(new Request('https://test.invalid/api/state',{headers:{cookie:'session='+role}}));assert.equal(response.status,200);return response.json();};
  assert.equal((await state()).user.appearance,'original');
  for(const theme of ['petrol','sage','graphite','original']){const response=await api('me/appearance',{theme,user:users.admin},'agent');assert.equal(response.status,200);assert.equal((await state('agent')).user.appearance,theme);assert.equal((await state()).user.appearance,'original');}
  assert.equal((await api('me/appearance',{theme:'graphite'},'viewer')).status,200);assert.equal((await state('viewer')).user.appearance,'graphite');
  assert.equal((await api('me/appearance',{theme:'invalid'},'agent')).status,400);assert.equal((await api('me/appearance',{theme:'petrol'},'missing')).status,401);
  for(let i=0;i<30;i++)await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,$4,'Other','open',$5,$5,$6)",[randomUUID(),tenant,aid,'customer-'+i,stamp,users.admin]);
  const foreignAccount=randomUUID(),foreignConversation=randomUUID();await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Foreign','instagram',$3,'demo')",[foreignAccount,otherTenant,seal({})]);await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,'foreign','Foreign','open',$4,$4)",[foreignConversation,otherTenant,foreignAccount,stamp]);
  const message=randomUUID();await query("insert into messages(id,conversation,direction,body,external,created,state) values($1,$2,'out','Mensagem',$3,$4,'sent')",[message,cid,aid+':external',stamp]);
  await query("insert into whatsapp_reactions(tenant,account,customer,event_external,target_external,emoji,created,from_me) values($1,$2,'customer','event-1','external','👍',$3,false),($1,$2,'customer','event-2','external','❤️',$4,false)",[tenant,aid,stamp-100,stamp]);
  await query("insert into whatsapp_deletions(tenant,account,customer,target_external,event_external,deleted_at,source) values($1,$2,'customer','external','delete-1',$3,'whatsapp')",[tenant,aid,stamp]);
  for(let i=0;i<55;i++)await query("insert into attendance_history(tenant,conversation,actor,actor_name,action,created) values($1,$2,$3,'Administrador','Histórico',$4)",[tenant,cid,users.admin,stamp+i]);
  queries.length=0;const snapshot=await state();assert.ok(queries.length<=13,'bounded snapshot query count: '+queries.length);assert.equal(snapshot.conversations.length,31);assert.ok(!snapshot.conversations.some(c=>c.id===foreignConversation));const current=snapshot.conversations.find(c=>c.id===cid);assert.equal(current.assignee_name,'Beatriz');assert.equal(current.messages[0].reactions[0].emoji,'❤️');assert.equal(current.messages[0].deletion.source,'whatsapp');assert.equal(current.attendance_history.length,50);assert.ok(!('position' in current.attendance_history[0]));
  const agentSnapshot=await state('agent');assert.equal(agentSnapshot.conversations.length,1);assert.equal(agentSnapshot.conversations[0].id,cid);
  await query('update conversations set assigned_to=null where id=$1',[cid]);const claimed=await (await api('conversations/'+cid+'/claim',{},'agent')).json();assert.equal(claimed.conversation.assigned_to,users.agent);assert.equal(claimed.conversation.assignee_name,'Beatriz');assert.equal(claimed.conversation.attendance_history.length,50);
  const response=await api('conversations/'+cid+'/status',{status:'resolved',source:'organic',had_scheduling:false},'agent');assert.equal(response.status,200);const closed=await response.json();assert.equal(closed.conversation.status,'resolved');assert.equal(closed.conversation.assigned_to,users.agent);assert.equal(closed.conversation.attendance_history[0].action,'Atendimento finalizado');assert.ok(Array.isArray(closed.touches));

  await query("update conversations set status='resolved',updated=$1 where tenant=$2 and id<>$3",[stamp-1000,tenant,cid]);
  const incremental=await (await app.fetch(new Request('https://test.invalid/api/state?since='+stamp,{headers:{cookie:'session=admin'}}))).json();assert.equal(incremental.partial,true);assert.equal(incremental.visible_conversation_ids.length,31);assert.equal(incremental.conversations.length,1);assert.equal(incremental.conversations[0].id,cid);assert.equal(incremental.conversations[0].status,'resolved');
  assert.equal((await api('conversations/'+cid+'/status',{status:'open'},'agent')).status,200);

 }finally{globalThis.fetch=originalFetch;delete globalThis.__acquarellaPool;await db.close();}
});
