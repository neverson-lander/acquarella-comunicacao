import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';

test('finalized archive paginates metadata, searches all authorized closed cases and reopens atomically',async()=>{
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
  let lock=Promise.resolve();globalThis.__acquarellaPool={query,connect:async()=>{const previous=lock;let release;lock=new Promise(resolve=>release=resolve);await previous;return {query,release};}};process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.PUBLIC_ORIGIN='https://test.invalid';
  const {default:app}=await import('../api/index.mjs');globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({message_id:'test-'+calls.length}),{status:200});};
  const api=(path,body,role='admin')=>app.fetch(new Request('https://test.invalid/api/'+path,{method:'POST',headers:{cookie:'session='+role,'content-type':'application/json'},body:JSON.stringify(body)}));
  const reply=(body,role='admin')=>api('conversations/'+cid+'/reply',body,role);


  const get=(path,role='agent')=>app.fetch(new Request('https://test.invalid/api/'+path,{headers:{cookie:'session='+role}}));
  const closed=randomUUID(),bulk=randomUUID();
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5534998877665','Júlia Martins','resolved',$4,$4,$5)",[closed,tenant,aid,stamp,users.admin]);
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,'5534987654321','Encerramento em massa','resolved',$4,$4)",[bulk,tenant,aid,stamp]);
  const foreignAccount=randomUUID(),foreignConversation=randomUUID();await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Foreign','instagram',$3,'demo')",[foreignAccount,otherTenant,seal({})]);await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,'foreign','Júlia Foreign','resolved',$4,$4)",[foreignConversation,otherTenant,foreignAccount,stamp]);
  for(let i=0;i<65;i++)await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,'Paginação','resolved',$5,$5)",[randomUUID(),tenant,aid,'5511000'+i,stamp]);
  queries.length=0;let page=await (await get('finalized-attendances')).json();assert.equal(page.items.length,30);assert.ok(page.nextCursor);assert.ok(queries.length<=3);assert.ok(!queries.some(sql=>/from messages|from attendance_history|from attendance_evaluations/.test(sql)));assert.ok(!('messages' in page.items[0]));
  const ids=page.items.map(c=>c.id);while(page.nextCursor){page=await (await get('finalized-attendances?cursor='+page.nextCursor)).json();ids.push(...page.items.map(c=>c.id));}assert.equal(ids.length,67);assert.equal(new Set(ids).size,67);assert.ok(!ids.includes(cid));assert.ok(!ids.includes(foreignConversation));
  const nameSearch=await (await get('finalized-attendances?q=julia')).json();assert.deepEqual(nameSearch.items.map(c=>c.id),[closed]);assert.equal((await (await get('finalized-attendances?q=8877')).json()).items[0].id,closed);assert.equal((await (await get('finalized-attendances?q='+encodeURIComponent('(34) 99887-7665'))).json()).items[0].id,closed);assert.equal((await (await get('finalized-attendances?q='+encodeURIComponent('%'))).json()).items.length,0);
  assert.equal((await (await get('finalized-attendances','noAccount')).json()).items.length,0);assert.equal((await get('finalized-attendances/'+closed,'noAccount')).status,403);assert.equal((await get('finalized-attendances/'+foreignConversation)).status,404);assert.equal((await get('finalized-attendances?cursor=bad')).status,400);
  for(let i=0;i<70;i++)await query("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in',$3,$4,'received')",[randomUUID(),closed,'Mensagem '+i,stamp+i]);
  const detail=await (await get('finalized-attendances/'+closed)).json();assert.equal(detail.conversation.messages.length,50);assert.equal(detail.conversation.messages[0].body,'Mensagem 20');assert.ok(detail.nextMessagesCursor);assert.equal(detail.canReopen,true);const older=await (await get('finalized-attendances/'+closed+'?before='+detail.nextMessagesCursor)).json();assert.equal(older.conversation.messages.length,20);assert.equal(older.conversation.messages[0].body,'Mensagem 0');assert.equal(older.nextMessagesCursor,null);assert.ok(detail.conversation.messages.every(m=>!m.can_delete&&!m.can_react));
  assert.equal((await (await get('finalized-attendances/'+bulk)).json()).conversation.messages.length,0);assert.equal((await (await get('finalized-attendances/'+bulk,'viewer')).json()).canReopen,false);assert.equal((await api('finalized-attendances/'+bulk+'/reopen',{},'viewer')).status,403);
  const reopened=await api('finalized-attendances/'+closed+'/reopen',{},'agent');assert.equal(reopened.status,200);const result=await reopened.json();assert.equal(result.conversation.status,'open');assert.equal(result.conversation.assigned_to,users.agent);assert.equal(result.conversation.assignee_name,'Beatriz');assert.equal(result.opportunity.owner,users.agent);assert.equal(result.conversation.messages.length,50);assert.equal(calls.length,0);assert.equal((await api('finalized-attendances/'+closed+'/reopen',{},'agent')).status,409);assert.equal((await get('finalized-attendances/'+closed)).status,409);
  const attempts=await Promise.all([api('finalized-attendances/'+bulk+'/reopen',{},'agent'),api('finalized-attendances/'+bulk+'/reopen',{},'admin')]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);assert.equal((await query("select count(*)::int as n from attendance_history where conversation=$1 and action='Atendimento reaberto'",[bulk])).rows[0].n,1);
 }finally{globalThis.fetch=originalFetch;delete globalThis.__acquarellaPool;await db.close();}
});
