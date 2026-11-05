import test from 'node:test';
import assert from 'node:assert/strict';
import {createCashbarber} from '../lib/cashbarber-store.mjs';
test('each role can connect its own CashBarber session without enabling automatic renewal',async()=>{
 const calls=[],audits=[],service=createCashbarber({pool:{},getConversation:()=>assert.fail('Connection must not require a conversation'),audit:async(...args)=>audits.push(args),client:{configured:()=>true,call:async(...args)=>{calls.push(args);return {connected:true};}}});
 const input={email:'recepcao@test.invalid',password:'example-password',branchId:'12',tenant:'other-company'};
 for(const role of ['admin','receptionist','agent','viewer']){
  const user={tenant:'company',name:role,role};
  for(let i=0;i<2;i++)assert.equal((await service.route(user,'/api/cashbarber/login',input)).connected,true);
  assert.deepEqual(calls.at(-1),['company','login',{email:input.email,password:input.password,branchId:'12'}]);
  assert.ok(audits.at(-1)[1].includes(role));
 }
 const count=calls.length;
 assert.equal(calls.length,count);
 await assert.rejects(service.route({tenant:'company',role:'receptionist'},'/api/cashbarber/login',{email:'recepcao@test.invalid',password:''}),e=>e.status===400);
 assert.equal(calls.length,count);
});
