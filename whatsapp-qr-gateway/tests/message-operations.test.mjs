import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {generateForwardMessageContent,generateWAMessageContent,generateWAMessageFromContent,proto} from 'baileys';
import {Store} from '../store.mjs';
import {Sessions,BufferJSON} from '../sessions.mjs';
import {createGateway} from '../server.mjs';
import {qrHeaders} from '../../vercel-app/lib/qr-protocol.mjs';

test('signed forwarding and editing produce native WhatsApp protocol, preserve captions and reject duplicate changes',async()=>{
 const store=new Store(':memory:',randomBytes(32).toString('base64'),{replacer:BufferJSON.replacer,reviver:BufferJSON.reviver}),sent=[],session=`${randomUUID()}_${randomUUID()}`,secret='secret-'.repeat(8),user='5534888888888@s.whatsapp.net';
 const socket={user:{id:user},ev:new EventEmitter(),end(){},onWhatsApp:async p=>[{jid:p+'@s.whatsapp.net',exists:true}],sendMessage:async(jid,content,options)=>{
  const native=content.forward?generateForwardMessageContent(content.forward,content.force):content.edit?await generateWAMessageContent(content,{}):content.image?{imageMessage:{caption:content.caption,mimetype:content.mimetype,contextInfo:content.contextInfo}}:content.document?{documentMessage:{caption:content.caption,fileName:content.fileName,contextInfo:content.contextInfo}}:await generateWAMessageContent(content,{});
  const message=generateWAMessageFromContent(jid,native,{...options,userJid:user});sent.push({jid,content,options,message});return message;
 }};
 const manager=new Sessions({store,secret,origin:'https://central.test',makeSocket:()=>socket,fetcher:async()=>new Response('%PDF-test')}),server=createGateway({store,secret,sessions:manager});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const send=async(action,input,signed=true)=>{const path=`/sessions/${session}/${action}`,body=JSON.stringify(input);return fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:signed?qrHeaders(secret,'POST',path,body):{},body});};
 try{
  await manager.connect(session);socket.ev.emit('connection.update',{connection:'open'});store.set(session,'message:original-out',{extendedTextMessage:{text:'Beatriz:\nOriginal'}});
  const edit={recipient:'5534999999999',external:'original-out',body:'Beatriz:\nCorrigido',idempotencyKey:'edit:'+randomUUID()};assert.equal((await send('edit',edit,false)).status,401);assert.equal((await send('edit',edit)).status,200);assert.equal((await send('edit',edit)).status,200);assert.equal(sent.length,1);
  const nativeEdit=sent[0].message.message.protocolMessage;assert.equal(nativeEdit.type,proto.Message.ProtocolMessage.Type.MESSAGE_EDIT);assert.equal(nativeEdit.key.id,'original-out');assert.equal(nativeEdit.key.fromMe,true);assert.equal(nativeEdit.editedMessage.extendedTextMessage.text,'Beatriz:\nCorrigido');assert.equal(store.get(session,'message:original-out').extendedTextMessage.text,'Beatriz:\nCorrigido');assert.equal((await send('edit',{...edit,body:'Another edit'})).status,409);
  store.set(session,'message:original-image',{imageMessage:{caption:'Legenda original',mimetype:'image/png',contextInfo:{stanzaId:'private-reference',quotedMessage:{conversation:'Do not forward quoted context'}}}});
  const forward={recipient:'5534999911111',source:{external:'original-image',customer:'5534999999999',fromMe:false,kind:'image',body:'Legenda original'},idempotencyKey:'forward:'+randomUUID()};assert.equal((await send('forward',forward,false)).status,401);assert.equal((await send('forward',forward)).status,200);assert.equal((await send('forward',forward)).status,200);assert.equal(sent.length,2);
  const image=sent.at(-1).message.message.imageMessage;assert.equal(image.caption,'Legenda original');assert.equal(image.contextInfo.isForwarded,true);assert.equal(image.contextInfo.quotedMessage,undefined);assert.equal((await send('forward',{...forward,recipient:'5534999922222'})).status,409);
  await send('forward',{...forward,source:{external:'original-out',customer:'5534999999999',fromMe:true,kind:'text',body:'Beatriz:\nCorrigido'},idempotencyKey:'forward:'+randomUUID()});assert.equal(sent.at(-1).message.message.extendedTextMessage.text,'Beatriz:\nCorrigido');
  await send('forward',{...forward,source:{external:'original-out',customer:'5534999999999',fromMe:true,kind:'text',body:'Beatriz:\nOriginal'},idempotencyKey:'forward:'+randomUUID()});assert.equal(sent.at(-1).message.message.extendedTextMessage.text,'Beatriz:\nOriginal');
  const beforeInvalidEdit=sent.length;assert.equal((await send('edit',{...edit,external:'original-image',idempotencyKey:'edit:'+randomUUID()})).status,400);assert.equal(sent.length,beforeInvalidEdit);
  const qrId=randomUUID();store.saveMedia(session,qrId,Buffer.from('image bytes'),'image/png');await send('forward',{...forward,source:{...forward.source,external:'expired-cache',qrId,caption:'Legenda preservada'},idempotencyKey:'forward:'+randomUUID()});assert.equal(sent.at(-1).content.image.toString(),'image bytes');assert.equal(sent.at(-1).content.caption,'Legenda preservada');assert.equal(sent.at(-1).content.contextInfo.isForwarded,true);
  await send('forward',{...forward,source:{...forward.source,external:'uploaded-file',kind:'document',caption:'PDF com legenda',delivery:{url:`https://central.test/api/attachments/${randomUUID()}/delivery?signature=test`,kind:'file',mime:'application/pdf',name:'arquivo.pdf'}},idempotencyKey:'forward:'+randomUUID()});assert.equal(sent.at(-1).content.document.toString(),'%PDF-test');assert.equal(sent.at(-1).content.caption,'PDF com legenda');
  const count=sent.length;assert.equal((await send('forward',{...forward,source:{...forward.source,external:'missing-attachment'},idempotencyKey:'forward:'+randomUUID()})).status,404);assert.equal(sent.length,count);assert.equal((await send('forward',{...forward,recipient:'5534888888888',idempotencyKey:'forward:'+randomUUID()})).status,400);
 }finally{manager.close();store.close();await new Promise(r=>server.close(r));}
});
