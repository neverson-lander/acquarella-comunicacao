import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';

test('quoted replies validate the received message and persist native context for text and attachments',async()=>{
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
  let responder;globalThis.fetch=(...args)=>responder(...args);const {default:app}=await import('../api/index.mjs');responder=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({message_id:'test-'+calls.length}),{status:200});};
  const api=(path,body,role='admin')=>app.fetch(new Request('https://test.invalid/api/'+path,{method:'POST',headers:{cookie:'session='+role,'content-type':'application/json'},body:JSON.stringify(body)}));
  const reply=(body,role='admin')=>api('conversations/'+cid+'/reply',body,role);

  await query("update accounts set channel='whatsapp',external='1234' where id=$1",[aid]);await query("update conversations set customer='5534999999999' where id=$1",[cid]);
  const incoming=randomUUID(),outgoing=randomUUID(),otherCid=randomUUID(),otherMessage=randomUUID();
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5534888888888','Other','open',$4,$4,$5)",[otherCid,tenant,aid,stamp,users.agent]);
  for(const [mid,conversation,direction,external] of [[incoming,cid,'in',aid+':wamid.original'],[outgoing,cid,'out','wamid.outgoing'],[otherMessage,otherCid,'in','wamid.other']])await query("insert into messages(id,conversation,direction,body,external,created,state) values($1,$2,$3,'Qual o horário disponível?',$4,$5,'received')",[mid,conversation,direction,external,stamp]);
  responder=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({messages:[{id:'wamid.sent.'+calls.length}]}));};
  const response=await reply({body:'Temos às 15h.',reply_to:incoming,signature_user:users.agent});assert.equal(response.status,200);const result=await response.json();assert.equal(result.message.media.replyTo.messageId,incoming);assert.equal(result.message.media.replyTo.body,'Qual o horário disponível?');assert.equal(result.message.media.replyTo.external,'wamid.original');assert.deepEqual(calls[0].body.context,{message_id:'wamid.original'});assert.equal(calls[0].body.text.body,'Beatriz:\nTemos às 15h.');

  process.env.WHATSAPP_QR_URL='http://127.0.0.1:3100';process.env.WHATSAPP_QR_SECRET='test-'.repeat(10);await query('update accounts set secret=$1 where id=$2',[seal({transport:'qr'}),aid]);
  const metaFetch=responder;responder=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({external:'native-qr-quoted'});};
  const qrResponse=await reply({body:'Resposta pelo QR',reply_to:incoming});assert.equal(qrResponse.status,200);assert.deepEqual(calls.at(-1).body.replyTo,{external:'wamid.original',body:'Qual o horário disponível?'});assert.equal((await qrResponse.json()).message.media.replyTo.messageId,incoming);
  responder=metaFetch;await query('update accounts set secret=$1 where id=$2',[seal({token:'TEST_TOKEN'}),aid]);
  const before=calls.length;for(const target of [outgoing,otherMessage,randomUUID()])assert.equal((await reply({body:'Não enviar',reply_to:target})).status,409);assert.equal((await reply({body:'Não enviar',reply_to:'invalid'})).status,400);assert.equal(calls.length,before);
  assert.equal((await reply({body:'Visualizador',reply_to:incoming},'viewer')).status,403);assert.equal((await reply({body:'Outra empresa',reply_to:incoming},'foreign')).status,404);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const upload=await (await api('conversations/'+cid+'/attachments',{name:'teste.png',type:'image/png',size:png.length})).json();assert.equal((await api(`conversations/${cid}/attachments/${upload.id}/part`,{part:0,data:png.toString('base64')})).status,200);assert.equal((await api(`conversations/${cid}/attachments/${upload.id}/finish`,{})).status,200);
  assert.equal((await reply({body:'Veja a imagem',reply_to:incoming,attachmentId:upload.id})).status,200);assert.deepEqual(calls.at(-1).body.context,{message_id:'wamid.original'});assert.deepEqual(calls.at(-2).body.context,{message_id:'wamid.original'});assert.equal(calls.at(-2).body.type,'image');
  await query("insert into whatsapp_deletions(tenant,account,customer,target_external,event_external,deleted_at,source) values($1,$2,'5534999999999','wamid.original','deleted',$3,'whatsapp')",[tenant,aid,stamp]);assert.equal((await reply({body:'Não enviar',reply_to:incoming})).status,409);
  assert.equal((await reply({body:'Mensagem normal sem referência'})).status,200);assert.ok(!calls.at(-1).body.context);
 }finally{globalThis.fetch=originalFetch;delete process.env.WHATSAPP_QR_URL;delete process.env.WHATSAPP_QR_SECRET;delete globalThis.__acquarellaPool;await db.close();}
});
