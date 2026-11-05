import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';

test('reply bypasses unrelated backlog and returns the confirmed message without reloading state',async()=>{
 const db=new PGlite(),stamp=Date.now(),originalFetch=globalThis.fetch,calls=[];
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
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

  const otherConversation=randomUUID();await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'other','Other','open',$4,$4,$5)",[otherConversation,tenant,aid,stamp,users.agent]);
  for(let i=0;i<12;i++)await query("insert into jobs(id,tenant,account,conversation,kind,recipient,body,state,error,created) values($1,$2,$3,$4,'reply','other','Older queued reply','pending','',$5)",[randomUUID(),tenant,aid,otherConversation,stamp-10000+i]);
  const response=await reply({body:'Resposta prioritária',signature_user:users.agent});assert.equal(response.status,200);const result=await response.json();
  assert.equal(calls.length,1);assert.equal(calls[0].body.recipient.id,'customer');assert.equal(result.state,'sent');assert.equal(result.message.state,'sent');assert.equal(result.message.body,'Resposta prioritária');assert.equal(result.message.signature_name,'Beatriz');assert.equal(result.message.operator_id,users.admin);assert.equal(result.message.conversation,cid);assert.equal(result.message.external,'test-1');assert.ok(result.updated>=stamp);
  assert.equal((await query("select count(*)::int as n from jobs where conversation=$1 and state='pending'",[otherConversation])).rows[0].n,12);
  globalThis.fetch=async()=>{throw Error('Provider disconnected');};const uncertain=await (await reply({body:'Entrega para verificar'})).json();assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.message.state,'uncertain');
 }finally{globalThis.fetch=originalFetch;delete globalThis.__acquarellaPool;await db.close();}
});
