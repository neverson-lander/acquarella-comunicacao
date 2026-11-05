import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCashbarberClient} from '../lib/cashbarber-client.mjs';
import {createCashbarber} from '../lib/cashbarber-store.mjs';
test('server chooses operator scope per request and cannot be overridden by browser input',async()=>{
  const tenant=randomUUID(),a=randomUUID(),b=randomUUID(),calls=[];
  const client=createCashbarberClient({env:{CASHBARBER_URL:'http://cashbarber:3200',CASHBARBER_SECRET:'s'.repeat(40)},fetcher:async(_url,opts)=>{calls.push(JSON.parse(opts.body));return Response.json({connected:true});}});
  const store=createCashbarber({pool:{},client,audit:async()=>{},getConversation:async()=>{throw Error('not needed');}});
  for(const id of [a,b])await store.route({id,tenant,role:'agent'},'/api/cashbarber/login',{email:'operator@example.invalid',password:'password',remember:true,_scope:{kind:'service'}});
  assert.deepEqual(calls.map(c=>c._scope),[{kind:'operator',id:a},{kind:'operator',id:b}]);assert.ok(calls.every(c=>c.remember===undefined));
  await client.forService().call(tenant,'status',{_scope:{kind:'operator',id:a}});assert.deepEqual(calls.at(-1)._scope,{kind:'service'});
  await assert.rejects(client.call(tenant,'status'),e=>e.status===409);
});
