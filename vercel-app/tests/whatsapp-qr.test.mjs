import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash,createCipheriv} from 'node:crypto';
import {qrHeaders,validQrSignature,requiresServiceWindow,isQrAccount} from '../lib/qr-protocol.mjs';
import {createQrClient,qrConfiguration} from '../lib/whatsapp-qr.mjs';
import {messageContent} from '../public/message-content.js';

test('legacy accounts retain official transport; QR configuration never accepts form-provided arbitrary hosts',()=>{
  assert.equal(requiresServiceWindow({channel:'whatsapp',secret:'{}'}),true);
  assert.equal(isQrAccount({channel:'whatsapp',secret:'{"transport":"qr"}'}),true);
  assert.equal(isQrAccount({channel:'instagram',secret:'{"transport":"qr"}'}),false);
  for(const url of ['http://example.com','https://user:pass@example.com','https://example.com/path','file:///tmp/a'])assert.throws(()=>qrConfiguration({WHATSAPP_QR_URL:url,WHATSAPP_QR_SECRET:'a'.repeat(32),NODE_ENV:'production'}));
  assert.ok(messageContent({id:randomUUID(),kind:'image',direction:'in',body:'Imagem',media:{qrId:randomUUID(),name:'foto.png'}},v=>v).includes('/api/messages/'));
});

test('gateway transport preserves uncertain send errors and signs requests without exposing its secret',async()=>{
  const account={id:randomUUID(),tenant:randomUUID()},secret='s'.repeat(40),calls=[];
  const client=createQrClient({env:{WHATSAPP_QR_URL:'https://gateway.test',WHATSAPP_QR_SECRET:secret},fetcher:async(url,options)=>{
    calls.push({url,options});return new Response(JSON.stringify({error:'Envio incerto',definite:false}),{status:409});
  }});
  await assert.rejects(client.send(account,'5534999999999','Olá',null,'job-1'),error=>error.definite===false&&error.message==='Envio incerto');
  const call=calls[0],path=new URL(call.url).pathname;
  assert.equal(validQrSignature(secret,'POST',path,new Headers(call.options.headers),call.options.body),true);
  assert.ok(!JSON.stringify(call).includes(secret));
});

test('real API + PostgreSQL: QR creation, admin/tenant guards, webhook deduplication, reply and media use the new transport; Meta retains its window',async()=>{
  const db=new PGlite(),key=randomBytes(32),secret='QR_TEST_SECRET_'.repeat(4),tenant=randomUUID(),otherTenant=randomUUID();
  const seal=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');};
  const query=async(sql,args=[])=>{const result=await db.query(sql,args);for(const f of result.fields||[])if(f.dataTypeID===20)for(const row of result.rows)if(row[f.name]!==null)row[f.name]=Number(row[f.name]);return {...result,rowCount:result.affectedRows??result.rows.length};};
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  globalThis.__acquarellaPool={query,connect:async()=>({query,release(){}})};
  process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.WHATSAPP_QR_URL='https://gateway.test';process.env.WHATSAPP_QR_SECRET=secret;
  for(const id of [tenant,otherTenant])await query("insert into tenants(id,name,phone) values($1,'Test','5534888888888')",[id]);
  const users={};for(const role of ['admin','agent','outsider']){
    const user={id:randomUUID(),tenant:role==='outsider'?otherTenant:tenant,role:role==='agent'?'agent':'admin'};users[role]=user;
    await query("insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,'Operador',$3,'unused',$4,'[]')",[user.id,user.tenant,role+'@test.invalid',user.role]);
    await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(role).digest('hex'),user.id,Date.now()+3600000]);
  }
  const originalFetch=globalThis.fetch,calls=[];let qrMedia=Buffer.from('image bytes'),sendCount=0;
  globalThis.fetch=async(url,options={})=>{
    url=String(url);calls.push({url,options});const path=new URL(url).pathname;
    if(url.startsWith('https://gateway.test/')){
      assert.equal(validQrSignature(secret,options.method,path,new Headers(options.headers),options.body||''),true);
      if(path.endsWith('/messages'))return Response.json({external:'sent-from-qr-'+(++sendCount)});
      if(path.includes('/media/'))return new Response(qrMedia,{headers:{'content-type':'image/png'}});
      return Response.json({transport:'qr',status:'connected',connected:true,phone:'5534888888888'});
    }
    if(url.startsWith('https://graph.facebook.com/'))return Response.json({messages:[{id:'sent-meta'}]});
    throw Error('Unexpected URL '+url);
  };
  try{
    const {default:app}=await import('../api/index.mjs');
    const api=(path,body,user='admin')=>app.fetch(new Request('https://central.test/api/'+path,{method:body?'POST':'GET',headers:{cookie:'session='+user,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
    const saved=await api('accounts',{name:'WhatsApp QR',channel:'whatsapp',transport:'qr',mode:'live'});assert.equal(saved.status,200);
    const {id:aid}=await saved.json();assert.ok(aid);
    const account=(await query('select * from accounts where id=$1',[aid])).rows[0];
    assert.equal(account.external,aid);
    assert.equal((await api(`accounts/${aid}/qr/connect`,{})).status,200);
    assert.equal((await api(`accounts/${aid}/qr/connect`,{},'agent')).status,403);
    assert.equal((await api(`accounts/${aid}/qr`,undefined,'outsider')).status,403);
    assert.equal((await api('accounts',{id:aid,name:'Changed',transport:'meta',mode:'demo'})).status,400);
    const event={id:'incoming-1',session:tenant+'_'+aid,message:{external:'incoming-1',customer:'5534999999999',fromMe:false,name:'Maria',timestamp:Date.now()-172800000,body:'Olá',kind:'text'}};
    const webhook=async(value=event,headers)=>{const path='/webhooks/whatsapp-qr/'+aid,body=JSON.stringify(value);return app.fetch(new Request('https://central.test'+path,{method:'POST',headers:headers||qrHeaders(secret,'POST',path,body),body}));};
    assert.equal((await webhook(event,{'content-type':'application/json'})).status,403);
    assert.equal((await webhook({...event,session:otherTenant+'_'+aid})).status,400);
    assert.equal((await webhook()).status,200);assert.equal((await webhook()).status,200);
    const conversation=(await query('select * from conversations where account=$1',[aid])).rows[0];
    assert.equal(conversation.name,'Maria');assert.equal((await query('select id from messages')).rows.length,1);
    assert.equal((await query('select id from crm_opportunities where conversation=$1',[conversation.id])).rows.length,1);
    assert.equal((await api(`conversations/${conversation.id}/claim`,{})).status,200);
    assert.equal((await api(`conversations/${conversation.id}/reply`,{body:'Respondida pelo painel'})).status,200);
    const send=calls.find(c=>c.url.endsWith('/messages'));const payload=JSON.parse(send.options.body);
    assert.equal(payload.body,'Operador:\nRespondida pelo painel');assert.equal(payload.recipient,event.message.customer);assert.ok(payload.idempotencyKey);
    const outbound=(await query("select * from messages where direction='out'" )).rows[0];assert.equal(outbound.external,'sent-from-qr-1');assert.equal(outbound.operator_id,users.admin.id);
    const file=Buffer.from('%PDF-1.7\nQR attachment'),base=`conversations/${conversation.id}/attachments`;
    const upload=await api(base,{name:'teste.pdf',type:'application/pdf',size:file.length});assert.equal(upload.status,200);const attachment=await upload.json();
    assert.equal((await api(`${base}/${attachment.id}/part`,{part:0,data:file.toString('base64')})).status,200);
    assert.equal((await api(`${base}/${attachment.id}/finish`,{})).status,200);
    assert.equal((await api(`conversations/${conversation.id}/reply`,{attachmentId:attachment.id})).status,200);
    const fileSend=calls.filter(c=>c.url.endsWith('/messages')).map(c=>JSON.parse(c.options.body)).find(p=>p.media);
    assert.equal(fileSend.media.kind,'file');assert.equal(fileSend.media.mime,'application/pdf');assert.equal(fileSend.media.name,'teste.pdf');assert.ok(fileSend.media.url.includes('/delivery?'));
    const image={...event,id:'incoming-image',message:{...event.message,external:'incoming-image',timestamp:Date.now(),kind:'image',body:'Foto',media:{qrId:randomUUID(),name:'foto.png',mime_type:'image/png',size:qrMedia.length}}};
    assert.equal((await webhook(image)).status,200);
    const mediaMessage=(await query("select * from messages where kind='image'" )).rows[0];
    const response=await api(`messages/${mediaMessage.id}/media`);assert.equal(response.status,200);assert.equal(Buffer.from(await response.arrayBuffer()).toString(),qrMedia.toString());
    assert.equal((await api(`messages/${mediaMessage.id}/media`,undefined,'outsider')).status,404);
    const echo={...event,id:'echo-1',message:{...event.message,external:'echo-1',fromMe:true,timestamp:Date.now(),body:'Resposta no celular'}};
    assert.equal((await webhook(echo)).status,200);assert.equal((await webhook(echo)).status,200);
    const mirrored=(await query("select * from messages where external='echo-1'" )).rows;assert.equal(mirrored.length,1);assert.equal(mirrored[0].operator_name,'WhatsApp vinculado');assert.equal(mirrored[0].operator_id,null);
    const meta=randomUUID(),cid=randomUUID();
    await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'Official','whatsapp','123',$3,'live')",[meta,tenant,seal({token:'TOKEN',appSecret:'SECRET'})]);
    await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5534999999999','Meta','open',$4,$4,$5)",[cid,tenant,meta,Date.now()-172800000,users.admin.id]);
    assert.equal((await api(`conversations/${cid}/reply`,{body:'Old window'})).status,400);
    await query('update conversations set last_inbound=$1 where id=$2',[Date.now(),cid]);
    assert.equal((await api(`conversations/${cid}/reply`,{body:'Official reply'})).status,200);
    assert.ok(calls.some(c=>c.url.startsWith('https://graph.facebook.com/')));

    // Weekly forwarding exercises the real API, database, inbound adapter and
    // outbound queue. All provider calls stay inside the fake transport above.
    const hours={enabled:true,timezone:'America/Sao_Paulo',days:Array.from({length:7},()=>[{start:'09:00',end:'18:00'}])};
    const destination='5534977777777',config={serviceHours:hours,forwardingEnabled:true,forwardingPhone:destination,forwardingPeriod:'inside',bridge:null};
    const route=`accounts/${aid}/service-hours`;
    assert.equal((await api(route,config,'agent')).status,403);
    assert.equal((await api(route,config,'outsider')).status,403);
    const foreignSender=randomUUID();await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Other tenant','whatsapp',$3,'live')",[foreignSender,otherTenant,seal({transport:'qr'})]);
    assert.equal((await api(route,{...config,bridge:foreignSender})).status,403);
    assert.equal((await api(route,{...config,serviceHours:{...hours,enabled:false}})).status,400);
    assert.equal((await api(route,{...config,forwardingPhone:'5534888888888'})).status,400);
    assert.equal((await api(route,config)).status,200);
    const scheduled=(await query('select * from accounts where id=$1',[aid])).rows[0];assert.equal(scheduled.forwarding_phone,destination);assert.equal(scheduled.bridge,null);
    const messagesBefore=(await query('select count(*) as n from messages')).rows[0].n;
    const inboundAt=(id,time,extra={})=>({...event,id,message:{...event.message,external:id,timestamp:Date.parse(time),...extra}});
    const forwardCount=()=>calls.filter(c=>c.url.endsWith('/messages')&&JSON.parse(c.options.body).recipient===destination).length;
    const insideEvent=inboundAt('hours-inside','2020-01-06T10:00:00-03:00');
    let forwards=forwardCount();assert.equal((await webhook(insideEvent)).status,200);assert.equal(forwardCount(),forwards+1);
    assert.equal((await webhook(insideEvent)).status,200);assert.equal(forwardCount(),forwards+1);
    const outsideEvent=inboundAt('hours-outside','2020-01-06T23:00:00-03:00');
    assert.equal((await webhook(outsideEvent)).status,200);assert.equal(forwardCount(),forwards+1);
    assert.equal((await query('select count(*) as n from messages')).rows[0].n,messagesBefore+2);
    assert.equal((await api(route,{...config,forwardingPeriod:'outside'})).status,200);
    assert.equal((await query('select service_hours from accounts where id=$1',[meta])).rows[0].service_hours.enabled,false);
    const outsideAllowed=inboundAt('hours-outside-allowed','2020-01-06T23:00:00-03:00');
    assert.equal((await webhook(outsideAllowed)).status,200);assert.equal(forwardCount(),forwards+2);
    const forwardJob=(await query("select * from jobs where kind='forward' and state='sent' and recipient=$1 order by created desc limit 1",[destination])).rows[0];assert.ok(forwardJob.external);
    // Authorized quoted replies remain possible after crossing the grade and
    // only the exact configured destination (including the Brazilian alias) can reply.
    const reply=inboundAt('hours-quoted-reply','2020-01-06T10:00:00-03:00',{customer:'553477777777',context:forwardJob.external,body:'Resposta autorizada da equipe'});
    const clientReplies=()=>calls.filter(c=>c.url.endsWith('/messages')&&JSON.parse(c.options.body).body==='Equipe WhatsApp:\nResposta autorizada da equipe').length;
    const beforeReply=clientReplies();assert.equal((await webhook(reply)).status,200);assert.equal(clientReplies(),beforeReply+1);
    assert.equal((await webhook(reply)).status,200);assert.equal(clientReplies(),beforeReply+1);
    assert.ok((await query('select * from bridge_windows where account=$1 and phone=$2',[aid,destination])).rows.length);
    const loop=inboundAt('hours-loop','2020-01-06T23:00:00-03:00',{customer:destination});
    forwards=forwardCount();assert.equal((await webhook(loop)).status,200);assert.equal(forwardCount(),forwards);
    const spoof=inboundAt('hours-spoof','2020-01-06T10:00:00-03:00',{customer:'553466666666',context:forwardJob.external,body:'Resposta autorizada da equipe'});
    assert.equal((await webhook(spoof)).status,200);assert.equal(clientReplies(),beforeReply+1);
    const staleJob=randomUUID();await query("insert into jobs(id,tenant,account,conversation,message,kind,recipient,body,state,error,created) select $1,tenant,account,conversation,message,kind,recipient,body,'pending','',created from jobs where id=$2",[staleJob,forwardJob.id]);
    assert.equal((await api(route,{...config,forwardingEnabled:false,forwardingPeriod:'outside'})).status,200);
    assert.equal((await query('select state from jobs where id=$1',[staleJob])).rows[0].state,'cancelled');
    assert.equal((await webhook(inboundAt('hours-disabled','2020-01-06T23:00:00-03:00'))).status,200);assert.equal(forwardCount(),forwards);

    const state=await (await api('state')).json(),visible=JSON.stringify(state);
    assert.ok(!visible.includes(secret));assert.ok(!visible.includes('TOKEN'));assert.ok(!visible.includes('APP_ENCRYPTION_KEY'));
    assert.equal(state.accounts.find(a=>a.id===aid).transport,'qr');assert.equal(state.accounts.find(a=>a.id===meta).transport,'meta');
  }finally{globalThis.fetch=originalFetch;await db.close();}
});
