import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {resolveRecipient} from '../messages.mjs';
import {Store} from '../store.mjs';
import {Sessions} from '../sessions.mjs';
const configured='5534984411948',registered='553484411948@s.whatsapp.net';
test('recipient lookup uses the WhatsApp registered identity for Brazilian ninth-digit aliases',async()=>{
 const calls=[];const socket={onWhatsApp:async(...phones)=>{calls.push(phones);return [{jid:registered,exists:true}];}};
 assert.equal(await resolveRecipient(socket,configured),registered);assert.deepEqual(calls[0],[configured,'553484411948']);
 for(const result of [[],[{jid:registered,exists:false}],[{jid:'5511999999999@s.whatsapp.net',exists:true}],[{jid:'123@g.us',exists:true}]])await assert.rejects(resolveRecipient({onWhatsApp:async()=>result},configured),/Número não localizado/);
 await assert.rejects(resolveRecipient(socket,'invalid'),/Telefone/);
});
test('sending records the resolved destination and device receipts without resending an accepted message',async()=>{
 const store=new Store(':memory:',randomBytes(32).toString('base64')),session=randomUUID()+'_'+randomUUID(),sent=[];
 const socket={ev:new EventEmitter(),user:{id:'5534999999999@s.whatsapp.net'},onWhatsApp:async()=>[{jid:registered,exists:true}],sendMessage:async(jid,body,options)=>{sent.push(jid);return {key:{id:options.messageId}};},end(){}};
 const manager=new Sessions({store,origin:'https://central.test',secret:'s'.repeat(40),makeSocket:()=>socket});
 try{
  await manager.connect(session);socket.ev.emit('connection.update',{connection:'open'});
  const input={recipient:configured,body:'Teste',idempotencyKey:'one-send'},result=await manager.send(session,input);
  assert.deepEqual(sent,[registered]);const key='delivery:'+result.external;
  assert.equal(store.get(session,key).requested,configured);assert.equal(store.get(session,key).recipient,'553484411948');assert.equal(store.get(session,key).status,1);
  socket.ev.emit('messages.update',[{key:{id:result.external},update:{status:2}}]);assert.equal(store.get(session,key).status,2);
  socket.ev.emit('message-receipt.update',[{key:{id:result.external},receipt:{receiptTimestamp:123}}]);assert.equal(store.get(session,key).status,3);
  socket.ev.emit('messages.update',[{key:{id:result.external},update:{status:2}}]);assert.equal(store.get(session,key).status,3);
  socket.ev.emit('message-receipt.update',[{key:{id:result.external},receipt:{readTimestamp:124}}]);assert.equal(store.get(session,key).status,4);
  assert.deepEqual(await manager.send(session,input),result);assert.equal(sent.length,1);assert.equal(store.get('other',key),undefined);
  socket.onWhatsApp=async()=>[];await assert.rejects(manager.send(session,{...input,idempotencyKey:'invalid-number'}),e=>e.definite===true);assert.equal(sent.length,1);assert.equal(store.sent(session,'invalid-number'),undefined);
 }finally{manager.close();store.close();}
});
