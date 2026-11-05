import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';

test('real API: admin-selected signatures reach the provider while the real sender and ownership remain recorded',async()=>{
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
  assert.equal((await reply({body:'Continuando seu atendimento',signature_user:users.agent})).status,200);
  assert.equal(calls.at(-1).body.message.text,'Beatriz:\nContinuando seu atendimento');
  const first=(await query('select * from messages where conversation=$1',[cid])).rows[0];assert.equal(first.operator_id,users.admin);assert.equal(first.operator_name,'Administrador');assert.equal(first.signature_user,users.agent);assert.equal(first.signature_name,'Beatriz');
  assert.equal((await query('select assigned_to from conversations where id=$1',[cid])).rows[0].assigned_to,users.agent);
  for(const target of [users.foreign,users.viewer,users.noAccount,randomUUID()])assert.equal((await reply({body:'Não enviar',signature_user:target})).status,403);
  assert.equal((await reply({body:'Não enviar',signature_user:'Beatriz'})).status,400);
  for(const role of ['agent','receptionist'])assert.equal((await reply({body:'Não enviar',signature_user:users.admin},role)).status,403);
  assert.equal((await reply({body:'Sem assinatura forjada'},'agent')).status,200);assert.equal(calls.at(-1).body.message.text,'Beatriz:\nSem assinatura forjada');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const upload=await (await api('conversations/'+cid+'/attachments',{name:'publicidade.png',type:'image/png',size:png.length})).json();
  assert.equal((await api(`conversations/${cid}/attachments/${upload.id}/part`,{part:0,data:png.toString('base64')})).status,200);
  assert.equal((await api(`conversations/${cid}/attachments/${upload.id}/finish`,{})).status,200);
  assert.equal((await reply({body:'Confira nossa promoção',attachmentId:upload.id,signature_user:users.agent})).status,200);assert.equal(calls.at(-1).body.message.text,'Beatriz:\nConfira nossa promoção');
  const records=(await query('select * from messages where conversation=$1 and operator_id=$2',[cid,users.admin])).rows;assert.equal(records.length,3);assert.ok(records.every(m=>m.signature_user===users.agent&&m.signature_name==='Beatriz'));
  await query("update accounts set mode='demo' where id=$1",[aid]);assert.equal((await reply({body:'Demonstração',signature_user:users.agent})).status,200);const demo=(await query("select * from messages where state='simulated'")).rows[0];assert.equal(demo.operator_id,users.admin);assert.equal(demo.signature_user,users.agent);
  await query("update conversations set status='resolved' where id=$1",[cid]);assert.equal((await reply({body:'Encerrado',signature_user:users.agent})).status,403);
 }finally{globalThis.fetch=originalFetch;delete globalThis.__acquarellaPool;await db.close();}
});
