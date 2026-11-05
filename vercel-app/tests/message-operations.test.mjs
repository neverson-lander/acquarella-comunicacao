import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createCipheriv,createHash} from 'node:crypto';
import {validQrSignature} from '../lib/qr-protocol.mjs';
import {createMessageOperations} from '../lib/message-operations.mjs';

async function fixture(){
 const db=new PGlite();for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};let waiting=Promise.resolve();const pool={query,connect:async()=>{const previous=waiting;let release;waiting=new Promise(r=>release=r);await previous;return {query,release};}};
 const tenant=randomUUID(),otherTenant=randomUUID(),account=randomUUID(),foreignAccount=randomUUID(),cid=randomUUID(),mid=randomUUID(),incoming=randomUUID(),users={},clock={value:Date.now()},calls=[];
 await query("insert into tenants(id,name,phone) values($1,'Company','5534999999999'),($2,'Other','5534888888888')",[tenant,otherTenant]);
 for(const [id,t] of [[account,tenant],[foreignAccount,otherTenant]])await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'WhatsApp','whatsapp',$3,'{}','live')",[id,t,'qr-'+id]);
 for(const role of ['admin','agent','other','viewer','foreign']){const id=randomUUID(),user={id,tenant:role==='foreign'?otherTenant:tenant,name:role==='agent'?'Beatriz':role,role:['other','foreign'].includes(role)?'agent':role,accounts:[role==='foreign'?foreignAccount:account]};users[role]=user;await query('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[id,user.tenant,user.name,role+'@test.invalid','unused',user.role,JSON.stringify(user.accounts)]);}
 await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5534999990000','Mariana','open',$4,$4,$5)",[cid,tenant,account,clock.value,users.agent.id]);
 await query("insert into messages(id,conversation,direction,body,kind,created,state,external,operator_id,operator_name,signature_name) values($1,$2,'out','Texto original','text',$3,'sent','original-out',$4,'Beatriz','Beatriz')",[mid,cid,clock.value-60000,users.agent.id]);
 await query("insert into messages(id,conversation,direction,body,kind,media,created,state,external) values($1,$2,'in','Comprovante','image',$3,$4,'received','original-image')",[incoming,cid,JSON.stringify({qrId:randomUUID(),name:'comprovante.png',mime_type:'image/png',caption:'Comprovante',replyTo:{name:'Não encaminhar a citação',body:'Privado'}}),clock.value-1000]);
 const qr={edit:async(a,input)=>{calls.push({kind:'edit',input});return {ok:true,external:'edit-'+calls.length};},forward:async(a,input)=>{calls.push({kind:'forward',input});return {ok:true,external:'forward-'+calls.length};}};
 const service=createMessageOperations({pool,permitted:(u,a)=>u.tenant===a.tenant&&(u.role==='admin'||u.accounts.includes(a.id)),usesQr:()=>true,qr,now:()=>clock.value,attachmentDelivery:async()=>{throw Error('Unexpected attachment fetch');}});
 return {db,query,pool,tenant,otherTenant,account,foreignAccount,cid,mid,incoming,users,clock,calls,qr,service};
}

test('native edits preserve signature, original audit, quote metadata and timestamps; replay and stale edits are guarded',async()=>{
 const f=await fixture();try{
  await f.query('update messages set media=$2 where id=$1',[f.mid,JSON.stringify({replyTo:{name:'Cliente',body:'Pergunta original'}})]);
  const input={id:randomUUID(),body:'Texto corrigido',expected_body:'Texto original',expected_edit:0};
  const result=await f.service.perform(f.users.agent,f.mid,'edit',input);assert.equal(result.state,'sent');assert.equal(result.message.body,'Texto corrigido');assert.equal(result.message.external,'original-out');assert.equal(Number(result.message.created),f.clock.value-60000);assert.equal(result.message.media.replyTo.body,'Pergunta original');assert.ok(result.message.media.edited);assert.equal(f.calls[0].input.body,'Beatriz:\nTexto corrigido');
  assert.equal((await f.service.perform(f.users.agent,f.mid,'edit',input)).state,'sent');assert.equal(f.calls.length,1);
  const history=await f.service.history(f.users.agent,f.mid);assert.equal(history.items[0].previous_body,'Texto original');assert.equal(history.items[0].body,'Texto corrigido');
  await assert.rejects(f.service.perform(f.users.agent,f.mid,'edit',{...input,id:randomUUID(),body:'Stale'}),e=>e.status===409);
  await assert.rejects(f.service.perform(f.users.admin,f.mid,'edit',input),e=>e.status===409);
  f.clock.value+=16*60000;assert.equal((await f.service.context(f.users.agent,f.mid)).canEdit,false);await assert.rejects(f.service.perform(f.users.agent,f.mid,'edit',{id:randomUUID(),body:'Expired',expected_body:'Texto corrigido',expected_edit:result.message.media.edited.at}),e=>e.status===403);
  f.clock.value-=16*60000;await f.query("update messages set operator_id=null,operator_name='WhatsApp vinculado',signature_name='' where id=$1",[f.mid]);
  assert.equal((await f.service.context(f.users.agent,f.mid)).canEdit,true);
  await f.service.perform(f.users.agent,f.mid,'edit',{id:randomUUID(),body:'Texto do telefone corrigido',expected_body:'Texto corrigido',expected_edit:result.message.media.edited.at});assert.equal(f.calls.at(-1).input.body,'Texto do telefone corrigido');
 }finally{await f.db.close();}
});

test('forward text and media to a registered contact or new number, without losing captions or taking another live attendance',async()=>{
 const f=await fixture();try{
  const input={id:randomUUID(),phone:'(34) 99991-1111',expected_body:'Comprovante',expected_edit:0};
  const result=await f.service.perform(f.users.agent,f.incoming,'forward',input);assert.equal(result.state,'sent');assert.equal(result.target.customer,'5534999911111');assert.equal(result.target.assigned_to,f.users.agent.id);assert.equal(result.message.kind,'image');assert.equal(result.message.media.caption,'Comprovante');assert.equal(result.message.media.replyTo,undefined);assert.ok(result.message.media.forwarded);assert.equal(f.calls[0].input.source.external,'original-image');assert.equal(f.calls[0].input.source.fromMe,false);assert.equal(f.calls[0].input.recipient,'5534999911111');
  assert.equal((await f.service.perform(f.users.agent,f.incoming,'forward',input)).state,'sent');assert.equal(f.calls.length,1);
  const contact=(await f.query('select * from crm_contacts where tenant=$1 and phone=$2',[f.tenant,'5534999911111'])).rows[0];assert.ok(contact);const targets=await f.service.targets(f.users.agent,f.incoming,new URLSearchParams({q:'1111'}));assert.equal(targets.items[0].id,contact.id);
  await f.query('update conversations set assigned_to=$2 where id=$1',[result.target.id,f.users.other.id]);
  await assert.rejects(f.service.perform(f.users.agent,f.incoming,'forward',{...input,id:randomUUID(),contact:contact.id}),e=>e.status===409);assert.equal(f.calls.length,1);
  await f.query("update conversations set status='resolved' where id=$1",[result.target.id]);const resumed=await f.service.perform(f.users.agent,f.mid,'forward',{id:randomUUID(),contact:contact.id,expected_body:'Texto original',expected_edit:0});assert.equal(resumed.target.status,'open');assert.equal(resumed.target.assigned_to,f.users.agent.id);assert.equal(resumed.message.body,'Beatriz:\nTexto original');assert.equal(f.calls.at(-1).input.source.body,'Beatriz:\nTexto original');
  assert.equal((await f.query("select count(*)::int as n from attendance_history where conversation=$1 and action='Reaberto por encaminhamento'",[result.target.id])).rows[0].n,1);
  const foreignContact=randomUUID();await f.query("insert into crm_contacts(id,tenant,account,name,phone,created) values($1,$2,$3,'Other','5534999922222',$4)",[foreignContact,f.otherTenant,f.foreignAccount,f.clock.value]);await assert.rejects(f.service.perform(f.users.agent,f.incoming,'forward',{id:randomUUID(),contact:foreignContact,expected_body:'Comprovante',expected_edit:0}),e=>e.status===403);
 }finally{await f.db.close();}
});

test('uncertain responses are retried with the same operation, failure does not change text, and concurrent edits cannot race',async()=>{
 const f=await fixture();try{
  const input={id:randomUUID(),body:'Novo texto',expected_body:'Texto original',expected_edit:0};let attempts=0;
  f.qr.edit=async(a,payload)=>{f.calls.push(payload);if(!attempts++)throw Object.assign(Error('Sem confirmação'),{definite:false,status:502});return {ok:true,external:'ack-recovered'};};
  const uncertain=await f.service.perform(f.users.agent,f.mid,'edit',input);assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.message.body,'Texto original');
  const recovered=await f.service.perform(f.users.agent,f.mid,'edit',input);assert.equal(recovered.state,'sent');assert.equal(recovered.message.body,'Novo texto');assert.equal(f.calls[0].idempotencyKey,f.calls[1].idempotencyKey);
  f.qr.edit=async()=>{throw Object.assign(Error('Desconectado'),{definite:true,status:503});};const failed=await f.service.perform(f.users.agent,f.mid,'edit',{id:randomUUID(),body:'Não aplicado',expected_body:'Novo texto',expected_edit:recovered.message.media.edited.at});assert.equal(failed.state,'failed');assert.equal(failed.message.body,'Novo texto');
  let started,release;const entered=new Promise(r=>started=r),held=new Promise(r=>release=r);f.qr.edit=async()=>{started();await held;return {ok:true,external:'ack-concurrent'};};
  const first=f.service.perform(f.users.agent,f.mid,'edit',{id:randomUUID(),body:'Primeiro',expected_body:'Novo texto',expected_edit:recovered.message.media.edited.at});await entered;
  await assert.rejects(f.service.perform(f.users.agent,f.mid,'edit',{id:randomUUID(),body:'Segundo',expected_body:'Novo texto',expected_edit:recovered.message.media.edited.at}),e=>e.status===409);release();assert.equal((await first).message.body,'Primeiro');
  await assert.rejects(f.service.perform(f.users.viewer,f.mid,'edit',{id:randomUUID(),body:'Viewer',expected_body:'Primeiro',expected_edit:f.clock.value}),e=>e.status===403);await assert.rejects(f.service.context(f.users.foreign,f.mid),e=>e.status===404);
 }finally{await f.db.close();}
});

test('real API exposes authorized action menus, signed native requests and on-demand editing history',async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch,calls=[],key=randomBytes(32),secret='test-'.repeat(10);
 try{
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update(JSON.stringify({transport:'qr'})),cipher.final()]);await f.query('update accounts set secret=$2 where id=$1',[f.account,Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64')]);
  for(const [role,user] of Object.entries(f.users))await f.query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(role).digest('hex'),user.id,Date.now()+3600000]);
  globalThis.__acquarellaPool=f.pool;process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.PUBLIC_ORIGIN='https://central.test';process.env.WHATSAPP_QR_URL='https://gateway.test';process.env.WHATSAPP_QR_SECRET=secret;
  globalThis.fetch=async(url,options)=>{const path=new URL(url).pathname;assert.equal(validQrSignature(secret,options.method,path,new Headers(options.headers),options.body),true);calls.push({path,input:JSON.parse(options.body)});return Response.json({ok:true,external:'native-action-'+calls.length});};
  const {default:app}=await import('../api/index.mjs');const api=(path,body,role='agent')=>app.fetch(new Request('https://central.test/api/'+path,{method:body?'POST':'GET',headers:{cookie:'session='+role,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
  const context=await (await api('messages/'+f.mid+'/actions')).json();assert.equal(context.canEdit,true);assert.equal(context.canForward,true);
  const input={id:randomUUID(),body:'Texto corrigido pela API',expected_body:'Texto original',expected_edit:0};let response=await api('messages/'+f.mid+'/edit',input);assert.equal(response.status,200);assert.equal((await response.json()).message.body,input.body);assert.ok(calls[0].path.endsWith('/edit'));assert.equal(calls[0].input.body,'Beatriz:\n'+input.body);
  response=await api('messages/'+f.mid+'/edit',input);assert.equal(response.status,200);assert.equal(calls.length,1);const history=await (await api('messages/'+f.mid+'/edits')).json();assert.equal(history.items[0].previous_body,'Texto original');
  response=await api('messages/'+f.incoming+'/forward',{id:randomUUID(),phone:'34999912222',expected_body:'Comprovante',expected_edit:0});assert.equal(response.status,200);const forwarded=await response.json();assert.equal(forwarded.state,'sent');assert.equal(forwarded.target.customer,'5534999912222');assert.ok(calls.at(-1).path.endsWith('/forward'));assert.equal(calls.at(-1).input.source.caption,'Comprovante');
  const directory=await (await api('messages/'+f.incoming+'/forward-targets?q=2222')).json();assert.equal(directory.items.length,1);assert.equal((await api('messages/'+f.mid+'/edit',{...input,id:randomUUID()},'viewer')).status,403);assert.equal((await api('messages/'+f.mid+'/actions',null,'foreign')).status,404);
 }finally{globalThis.fetch=originalFetch;delete globalThis.__acquarellaPool;delete process.env.WHATSAPP_QR_URL;delete process.env.WHATSAPP_QR_SECRET;await f.db.close();}
});
