import test from 'node:test';
import assert from 'node:assert/strict';
import {canDeleteWhatsAppMessage,canReactWhatsAppMessage} from '../lib/message-deletion.mjs';
const context={user:{id:'u',tenant:'t',role:'receptionist'},conversation:{id:'c',tenant:'t',account:'a',assigned_to:null,status:'open'},account:{id:'a',channel:'whatsapp',mode:'live',enabled:true},message:{direction:'out',state:'sent',external:'phone-message',operator_id:null,operator_name:'WhatsApp vinculado'},qr:true};
test('shared linked phone messages expose delete and reaction to supervisors and the assigned attendant',()=>{
 assert.equal(canDeleteWhatsAppMessage(context),true);assert.equal(canReactWhatsAppMessage(context),true);
 const agent={...context,user:{...context.user,role:'agent'},conversation:{...context.conversation,assigned_to:'u'}};
 assert.equal(canDeleteWhatsAppMessage(agent),true);assert.equal(canReactWhatsAppMessage(agent),true);
 assert.equal(canDeleteWhatsAppMessage({...agent,conversation:{...agent.conversation,assigned_to:'another'}}),false);
 assert.equal(canDeleteWhatsAppMessage({...agent,message:{...agent.message,operator_id:'another'}}),false);
 for(const role of ['admin','receptionist'])assert.equal(canDeleteWhatsAppMessage({...context,user:{...context.user,role}}),true);
});
test('message actions deny foreign tenants, disabled channels, viewers and deleted messages; received messages only allow reactions',()=>{
 for(const patch of [{user:{...context.user,role:'viewer'}},{user:{...context.user,tenant:'other'}},{account:{...context.account,enabled:false}},{message:{...context.message,deletion:{source:'whatsapp'}}},{qr:false}]){
  assert.equal(canDeleteWhatsAppMessage({...context,...patch}),false);assert.equal(canReactWhatsAppMessage({...context,...patch}),false);
 }
 const incoming={...context,message:{direction:'in',state:'received',external:'a:incoming'}};
 assert.equal(canDeleteWhatsAppMessage(incoming),false);assert.equal(canReactWhatsAppMessage(incoming),true);
});
