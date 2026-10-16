import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {attachmentInfo,CHUNK_SIZE} from '../public/attachment-policy.mjs';
import {createReplyAttachments,mediaPayload,checkFileHeader} from '../lib/reply-attachments.mjs';
import {messageContent} from '../public/message-content.js';

test('channel limits and file signatures reject unsupported, empty, oversized and disguised uploads',()=>{
 assert.equal(attachmentInfo('instagram',{name:'x.pdf',type:'application/pdf',size:100}).kind,'file');
 for(const file of [{name:'evil.exe',type:'application/octet-stream',size:10},{name:'x.jpg',type:'image/jpeg',size:0},{name:'x.jpg',type:'image/jpeg',size:9*1024*1024},{name:'x.docx',size:100}])assert.throws(()=>attachmentInfo('instagram',file));
 assert.throws(()=>attachmentInfo('whatsapp',{name:'x.mp4',type:'video/mp4',size:17*1024*1024}));
 assert.throws(()=>checkFileHeader('image/png',Buffer.from('MZ executable')));
 checkFileHeader('application/pdf',Buffer.from('%PDF-1.7\n'));
 assert.equal(mediaPayload('instagram','customer',{kind:'file'},'https://test/file').message.attachment.type,'file');
 assert.equal(mediaPayload('whatsapp','customer',{kind:'file',name:'orçamento.pdf'},'https://test/file').document.filename,'orçamento.pdf');
});

test('real API: tenant isolation, encrypted chunk upload, idempotent enqueue, Meta payload, signed delivery, ranges and expiry',async()=>{
 const db=new PGlite();const timestamp=Date.now();let clock=timestamp;
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);for(const field of r.fields||[])if(field.dataTypeID===20)for(const row of r.rows)if(row[field.name]!==null)row[field.name]=Number(row[field.name]);return {...r,rowCount:r.affectedRows??r.rows.length};};
 const pool={query,connect:async()=>({query,release(){}})};
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 const key=randomBytes(32),seal=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},open=value=>{const bytes=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());};
 const tenant=randomUUID(),uid=randomUUID(),aid=randomUUID(),cid=randomUUID(),outsider=randomUUID();
 await query("insert into tenants(id,name,phone) values($1,'Test','5534988748139')",[tenant]);
 for(const [id,email] of [[uid,'agent@test.invalid'],[outsider,'other@test.invalid']])await query("insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,'Operador',$3,'unused','agent',$4)",[id,tenant,email,JSON.stringify([aid])]);
 await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'Test','instagram','1784',$3,'live')",[aid,tenant,seal({token:'TEST_TOKEN',instagramApiId:'1234'})]);
 await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'customer','Test','open',$4,$4,$5)",[cid,tenant,aid,timestamp,uid]);
 for(const [id,session] of [[uid,'agent'],[outsider,'other']])await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(session).digest('hex'),id,timestamp+3600000]);
 globalThis.__acquarellaPool=pool;process.env.APP_ENCRYPTION_KEY=key.toString('base64');
 const {default:app}=await import('../api/index.mjs');
 const api=async(path,body,session='agent')=>app.fetch(new Request('https://test.invalid/api/'+path,{method:body?'POST':'GET',headers:{cookie:session?'session='+session:'','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
 const service=createReplyAttachments({pool,seal,open,key:()=>key,now:()=>clock,origin:()=>'https://test.invalid'});
 const base=`conversations/${cid}/attachments`,file=Buffer.alloc(CHUNK_SIZE+10,32);file.write('%PDF-1.7\n');
 const originalFetch=globalThis.fetch;const calls=[];
 try{
  assert.equal((await api(base,{name:'x.pdf',type:'application/pdf',size:file.length},'')).status,401);
  assert.equal((await api(base,{name:'x.pdf',type:'application/pdf',size:file.length},'other')).status,403);
  const started=await api(base,{name:'orçamento.pdf',type:'application/pdf',size:file.length});assert.equal(started.status,200);const {id}=await started.json();
  assert.equal((await api(`${base}/${id}/finish`,{})).status,400);
  for(let i=0;i<2;i++)assert.equal((await api(`${base}/${id}/part`,{part:i,data:file.subarray(i*CHUNK_SIZE,(i+1)*CHUNK_SIZE).toString('base64')})).status,200);
  const stored=(await query('select secret from reply_attachment_parts where attachment=$1',[id])).rows[0].secret;assert.ok(!stored.includes('%PDF'));assert.notEqual(stored,file.toString('base64'));
  assert.equal((await api(`${base}/${id}/finish`,{})).status,200);
  assert.equal((await api(`${base}/${id}/part`,{part:0,data:file.subarray(0,CHUNK_SIZE).toString('base64')})).status,400);
  globalThis.fetch=async(url,options)=>{calls.push({url,payload:JSON.parse(options.body)});return new Response(JSON.stringify({message_id:'meta-'+calls.length}));};
  const reply=await api(`conversations/${cid}/reply`,{attachmentId:id,body:'Olá 😊'});assert.equal(reply.status,200);assert.equal((await reply.json()).state,'sent');assert.equal(calls.length,2);
  assert.equal(calls[0].payload.message.attachment.type,'file');assert.equal(calls[1].payload.message.text,'Operador:\nOlá 😊');
  assert.equal((await api(`conversations/${cid}/reply`,{attachmentId:id,body:'Olá 😊'})).status,200);assert.equal(calls.length,2,'same attachment retry must not resend');
  const delivery=new URL(calls[0].payload.message.attachment.payload.url);
  const publicFile=await app.fetch(new Request(delivery));assert.equal(publicFile.status,200);assert.deepEqual(Buffer.from(await publicFile.arrayBuffer()),file);
  delivery.searchParams.set('signature','0'.repeat(64));assert.equal((await app.fetch(new Request(delivery))).status,403);
  const item=(await query('select message from reply_attachments where id=$1',[id])).rows[0];
  assert.equal((await api(`messages/${item.message}/media`,null,'')).status,401);
  const range=await service.response(id,{range:'bytes=1048570-1048580'});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,11);
  await assert.rejects(service.response(id,{range:'bytes=9999999-'}),e=>e.status===416);
  await assert.rejects(service.remove({id:outsider,tenant},{id:cid},id),e=>e.status===403);
  const signed=await service.delivery(id),parsed=new URL(signed.url);assert.equal(service.validSignature(id,parsed.searchParams.get('expires'),parsed.searchParams.get('signature')),true);clock+=16*60000;assert.equal(service.validSignature(id,parsed.searchParams.get('expires'),parsed.searchParams.get('signature')),false);
  const html=messageContent({id:item.message,body:'x',kind:'file',media:{attachmentId:id,name:'<script>.pdf'}},s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('/api/messages/'));
  assert.equal((await query("select relname from pg_class where relname in ('reply_attachments','reply_attachment_parts') and relrowsecurity")).rows.length,2);
 }finally{globalThis.fetch=originalFetch;delete globalThis.__acquarellaPool;await db.close();}
});
