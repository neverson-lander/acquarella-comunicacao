import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createCipheriv,hkdfSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {proto} from 'baileys';
import {Store} from '../store.mjs';
import {Sessions} from '../sessions.mjs';
import {normalizeMessage} from '../messages.mjs';

const session='test',sender='188369162219593@lid',target='original',secret=randomBytes(32);
function encrypted(){
 const key=hkdfSync('sha256',secret,Buffer.alloc(0),Buffer.from(target+sender+sender+'Message Edit'),32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const content=proto.Message.encode({protocolMessage:{type:proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,key:{id:target},editedMessage:{conversation:'Texto corrigido'}}}).finish();
 const payload=Buffer.concat([cipher.update(content),cipher.final(),cipher.getAuthTag()]);
 return {key:{id:'encrypted-edit',remoteJid:sender,remoteJidAlt:'553488092400@s.whatsapp.net',fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),message:{secretEncryptedMessage:{targetMessageKey:{id:target,fromMe:true,remoteJid:sender},secretEncType:'MESSAGE_EDIT',encPayload:payload,encIv:iv}}};
}
test('encrypted edits recover corrected text from the original secret and authenticate ciphertext',async()=>{
 const raw=encrypted(),options={session,socket:{},store:{get:()=>({messageContextInfo:{messageSecret:secret.toString('base64')}})}};
 const message=await normalizeMessage(raw,options);assert.equal(message.kind,'edit');assert.equal(message.body,'Texto corrigido');assert.deepEqual(message.edit,{target});assert.equal(message.customer,'553488092400');
 raw.message.secretEncryptedMessage.encPayload[0]^=1;
 await assert.rejects(normalizeMessage(raw,options));
 const fallback=await normalizeMessage(raw,{...options,skipMedia:true});assert.equal(fallback.kind,'unsupported');assert.match(fallback.body,/Mensagem editada/);assert.equal(fallback.edit,undefined);
 await assert.rejects(normalizeMessage(encrypted(),{...options,store:{get:()=>null}}),/mensagem original/);
});
test('normal, encrypted and offline edits reach the callback, while pin notices do not become messages',async()=>{
 const store=new Store(':memory:',randomBytes(32).toString('base64')),socket={ev:new EventEmitter(),end(){}},events=[];
 const manager=new Sessions({store,secret:'test-'.repeat(10),origin:'https://example.test',makeSocket:()=>socket,fetcher:async(_url,input)=>{events.push(JSON.parse(input.body));return new Response('{}');}});
 try{
  await manager.connect(session);store.set(session,'message:'+target,{messageContextInfo:{messageSecret:secret.toString('base64')}});
  const raw=encrypted();socket.ev.emit('messages.upsert',{type:'append',messages:[raw]});await manager.flush();
  for(let i=0;i<50&&manager.flushing;i++)await new Promise(r=>setImmediate(r));
  socket.ev.emit('messages.update',[{key:{id:target,remoteJid:'553488092400@s.whatsapp.net',fromMe:false},update:{messageTimestamp:raw.messageTimestamp+1,message:{editedMessage:{message:{conversation:'Outra correção'}}}}}]);
  for(let i=0;i<50&&manager.flushing;i++)await new Promise(r=>setImmediate(r));
  socket.ev.emit('messages.upsert',{type:'notify',messages:[{...raw,key:{...raw.key,id:'pin'},message:{pinInChatMessage:{key:{id:target}}}}]});await manager.flush();
  assert.deepEqual(events.map(e=>[e.message.kind,e.message.body,e.message.edit.target]),[['edit','Texto corrigido',target],['edit','Outra correção',target]]);
 }finally{manager.close();store.close();}
});
