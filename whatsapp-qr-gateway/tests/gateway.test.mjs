import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {Store} from '../store.mjs';
import {Sessions,BufferJSON} from '../sessions.mjs';
import {normalizeMessage,fetchAttachment,outboundContent} from '../messages.mjs';
import {createGateway} from '../server.mjs';
import {qrHeaders,validQrSignature} from '../../vercel-app/lib/qr-protocol.mjs';

const secret='test-'.repeat(10),session=`${randomUUID()}_${randomUUID()}`;
const makeStore=()=>new Store(':memory:',randomBytes(32).toString('base64'),{replacer:BufferJSON.replacer,reviver:BufferJSON.reviver});
const raw=(id='received-1')=>({key:{id,remoteJid:'5534999999999@s.whatsapp.net',fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),pushName:'Maria',message:{conversation:'Olá'}});

test('HMAC binds method, path, body and timestamp; expired and modified callbacks fail',()=>{
  const path='/test',body='{"ok":true}',headers=new Headers(qrHeaders(secret,'POST',path,body));
  assert.equal(validQrSignature(secret,'POST',path,headers,body),true);
  for(const [method,payload,url] of [['GET',body,path],['POST','{}',path],['POST',body,'/other']])assert.equal(validQrSignature(secret,method,url,headers,payload),false);
  assert.equal(validQrSignature(secret,'POST',path,new Headers(qrHeaders(secret,'POST',path,body,Date.now()-61000)),body),false);
});

test('encrypted session keys, buffers, media and messages remain scoped to session',()=>{
  const store=makeStore();try{
    const creds={token:'PRIVATE_TOKEN',bytes:Buffer.from([1,2,3])};store.set(session,'creds',creds);
    assert.deepEqual(store.get(session,'creds'),creds);assert.equal(store.get('other','creds'),undefined);
    assert.ok(!store.db.prepare('select value from secrets').get().value.includes('PRIVATE_TOKEN'));
    const id=randomUUID();store.saveMedia(session,id,Buffer.from('media'), 'image/png');
    assert.equal(store.media('other',id),null);assert.equal(store.media(session,id).bytes.toString(),'media');
    store.accept(session,raw());store.accept(session,raw());assert.equal(store.pending().length,1);
    store.enable(session);store.disable(session);assert.deepEqual(store.active(),[]);assert.equal(store.get(session,'creds'),undefined);
  }finally{store.close();}
});

test('normalization resolves LID, retains quoted replies, names, reactions and bounded media',async()=>{
  const store=makeStore(),socket={signalRepository:{lidMapping:{getPNForLID:async()=> '5534999999999@s.whatsapp.net'}}};
  try{
    const message={...raw(),key:{...raw().key,remoteJid:'123@lid'},message:{imageMessage:{mimetype:'image/png',fileLength:4,caption:'foto',contextInfo:{stanzaId:'quoted'}}}};
    const result=await normalizeMessage(message,{session,socket,store,download:async()=>Readable.from([Buffer.from('test')])});
    assert.equal(result.customer,'5534999999999');assert.equal(result.context,'quoted');assert.equal(result.name,'Maria');assert.equal(result.kind,'image');
    assert.equal(store.media(session,result.media.qrId).bytes.toString(),'test');
    const reaction=await normalizeMessage({...raw(),message:{reactionMessage:{key:{id:'target'},text:'👍'}}},{session,socket,store});
    assert.deepEqual(reaction.reaction,{target:'target',emoji:'👍'});
    const once=await normalizeMessage({...raw(),message:{viewOnceMessage:{message:{imageMessage:{mimetype:'image/png'}}}}},{session,socket,store,download:()=>assert.fail('view once must not download')});
    assert.equal(once.media,null);assert.equal(once.kind,'unsupported');
  }finally{store.close();}
});

test('attachment fetch rejects arbitrary hosts and paths; outbound documents preserve filename',async()=>{
  const origin='https://central.test';
  for(const url of ['https://evil.test/x','http://127.0.0.1/private',origin+'/api/state',origin+'/api/attachments/'+randomUUID()+'/delivery'])await assert.rejects(fetchAttachment({url},origin,()=>assert.fail('must not fetch')));
  const bytes=await fetchAttachment({url:`${origin}/api/attachments/${randomUUID()}/delivery?signature=test`},origin,async()=>new Response('data'));
  const content=outboundContent({recipient:'5534999999999',body:'PDF',media:{kind:'file',mime:'application/pdf',name:'arquivo.pdf'}},bytes);
  assert.equal(content.fileName,'arquivo.pdf');assert.equal(content.document.toString(),'data');
});

test('session lifecycle, send deduplication, own echoes and persistent callback retries',async()=>{
  const store=makeStore(),sockets=[],callbacks=[];let sends=0,callbackOk=false;
  const makeSocket=()=>{const socket={ev:new EventEmitter(),user:{id:'5534888888888:1@s.whatsapp.net'},sendMessage:async(jid,content,opts)=>{sends++;return {key:{id:opts.messageId}};},logout:async()=>{},end(){}};sockets.push(socket);return socket;};
  const manager=new Sessions({store,origin:'https://central.test',secret,makeSocket,fetcher:async(url,options)=>{callbacks.push([url,options]);return new Response('{}',{status:callbackOk?200:503});}});
  try{
    await manager.connect(session);await manager.connect(session);assert.equal(sockets.length,1);
    sockets[0].ev.emit('connection.update',{connection:'open'});assert.equal(manager.status(session).connected,true);
    const input={recipient:'5534999999999',body:'Olá',idempotencyKey:'job-1'};
    const result=await manager.send(session,input);assert.deepEqual(await manager.send(session,input),result);assert.equal(sends,1);
    await assert.rejects(manager.send(session,{...input,body:'changed'}));
    sockets[0].ev.emit('messages.upsert',{type:'notify',messages:[{...raw(result.external),key:{...raw().key,fromMe:true,id:result.external}}]});
    assert.equal(store.pending().length,0);
    store.accept(session,raw());await manager.flush();assert.equal(store.pending().length,0);
    const pending=store.db.prepare('select * from inbox').get();assert.equal(pending.done,0);assert.equal(pending.attempts,1);assert.ok(pending.event);
    callbackOk=true;store.db.prepare('update inbox set next=0').run();await manager.flush();
    assert.equal(store.db.prepare('select done from inbox').get().done,1);
    const [,options]=callbacks.at(-1);assert.equal(validQrSignature(secret,'POST',`/webhooks/whatsapp-qr/${session.split('_')[1]}`,new Headers(options.headers),options.body),true);
    await manager.disconnect(session);assert.equal(manager.status(session).connected,false);assert.equal(store.active().length,0);
  }finally{manager.close();store.close();}
});

test('HTTP routes require signatures and isolate session media, including byte ranges',async()=>{
  const store=makeStore(),mid=randomUUID();store.saveMedia(session,mid,Buffer.from('123456'),'text/plain');
  const server=createGateway({store,secret,sessions:{status:()=>({connected:false})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(origin+'/sessions/'+session)).status,401);
    let path=`/sessions/${session}/media/${mid}`;
    let response=await fetch(origin+path,{headers:{...qrHeaders(secret,'GET',path),'Range':'bytes=1-3'}});
    assert.equal(response.status,206);assert.equal(await response.text(),'234');
    path=`/sessions/${randomUUID()}_${randomUUID()}/media/${mid}`;
    assert.equal((await fetch(origin+path,{headers:qrHeaders(secret,'GET',path)})).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();}
});

test('pause preserves pairing, cancels pending callbacks and resume ignores the paused backlog',async()=>{
  const store=makeStore(),sockets=[];let logout=0;
  const manager=new Sessions({store,origin:'https://central.test',secret,makeSocket:()=>{const s={ev:new EventEmitter(),user:{id:'5534888888888@s.whatsapp.net'},end(){},logout:async()=>{logout++;}};sockets.push(s);return s;},fetcher:async()=>new Response('{}')});
  try{
    await manager.connect(session);sockets[0].ev.emit('connection.update',{connection:'open'});
    const creds=store.get(session,'creds');assert.ok(creds);
    store.accept(session,raw('pending-before-pause'));await manager.pause(session);
    assert.equal(manager.status(session).status,'paused');assert.equal(logout,0);assert.deepEqual(store.get(session,'creds'),creds);assert.deepEqual(store.active(),[]);assert.equal(store.pending().length,0);
    sockets[0].ev.emit('messages.upsert',{type:'notify',messages:[raw('paused-message')]});assert.equal(store.db.prepare("select count(*) as n from inbox where id='paused-message'").get().n,0);
    await manager.resume(session);sockets[1].ev.emit('connection.update',{connection:'open'});assert.equal(manager.status(session).connected,true);assert.deepEqual(store.active(),[session]);
    const old={...raw('old-backlog'),messageTimestamp:Math.floor(Date.now()/1000)-60};sockets[1].ev.emit('messages.upsert',{type:'notify',messages:[old]});assert.equal(store.db.prepare("select count(*) as n from inbox where id='old-backlog'").get().n,0);
    sockets[1].ev.emit('messages.upsert',{type:'notify',messages:[raw('fresh-resumed')]});
    for(let i=0;i<10&&manager.flushing;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(store.db.prepare("select count(*) as n from inbox where id='fresh-resumed'").get().n,1);
  }finally{manager.close();store.close();}
});

test('uncertain sends are never automatically resent with the same idempotency key',async()=>{
  const store=makeStore();let count=0;
  const manager=new Sessions({store,origin:'https://central.test',secret});
  const socket={user:{id:'5534999999999@s.whatsapp.net'},sendMessage:async()=>{count++;throw Error('timeout');},end(){}};
  manager.sessions.set(session,{status:'connected',socket});
  try{
    const message={recipient:'5534999999999',body:'Olá',idempotencyKey:'job-timeout'};
    await assert.rejects(manager.send(session,message),error=>error.definite===false);
    await assert.rejects(manager.send(session,message),error=>error.definite===false);
    assert.equal(count,1);
  }finally{manager.close();store.close();}
});
