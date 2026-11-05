import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {generateWAMessageFromContent} from 'baileys';
import {Store} from '../store.mjs';
import {Sessions,BufferJSON} from '../sessions.mjs';

test('QR sends native quoted replies with cached media or a retained text preview and protects replay identity',async()=>{
 const store=new Store(':memory:',randomBytes(32).toString('base64'),{replacer:BufferJSON.replacer,reviver:BufferJSON.reviver}),sent=[];
 const session=`${randomUUID()}_${randomUUID()}`,recipient='5534999999999',user='5534888888888@s.whatsapp.net';
 const socket={user:{id:user},ev:new EventEmitter(),end(){},onWhatsApp:async p=>[{jid:p+'@s.whatsapp.net',exists:true}],sendMessage:async(jid,content,options)=>{
  const protocol=generateWAMessageFromContent(jid,{extendedTextMessage:{text:content.text}},{...options,userJid:user});sent.push({content,options,protocol});return protocol;
 }};
 const manager=new Sessions({store,secret:'secret-'.repeat(8),origin:'https://central.test',makeSocket:()=>socket});
 try{
  await manager.connect(session);socket.ev.emit('connection.update',{connection:'open'});
  store.set(session,'message:cached-image',{imageMessage:{caption:'Imagem original',mimetype:'image/png'}});
  for(const external of ['cached-image','expired-cache']){
   const input={recipient,body:'Beatriz:\nResposta específica',idempotencyKey:'quoted:'+external,replyTo:{external,body:'Prévia original'}};
   const result=await manager.send(session,input);assert.ok(result.external);
   const native=sent.at(-1).protocol.message.extendedTextMessage.contextInfo;
   assert.equal(native.stanzaId,external);assert.equal(native.participant,recipient+'@s.whatsapp.net');
   if(external==='cached-image')assert.equal(native.quotedMessage.imageMessage.caption,'Imagem original');else assert.equal(native.quotedMessage.conversation,'Prévia original');
   assert.deepEqual(await manager.send(session,input),result);
   await assert.rejects(manager.send(session,{...input,replyTo:{...input.replyTo,external:'different-original'}}),e=>e.status===409);
  }
  assert.equal(sent.length,2);
  await assert.rejects(manager.send(session,{recipient,body:'Resposta',idempotencyKey:'bad-quote',replyTo:{external:'invalid id',body:'Original'}}),e=>e.status===400);
  await manager.send(session,{recipient,body:'Mensagem sem citação',idempotencyKey:'plain'});assert.equal(sent.at(-1).options.quoted,undefined);
 }finally{manager.close();store.close();}
});
