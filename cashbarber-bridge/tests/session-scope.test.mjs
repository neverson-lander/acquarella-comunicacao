import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolveSessionScope,journalTenant} from '../session-scope.mjs';
import {CashApi} from '../api.mjs';
import {CashConnection} from '../connection.mjs';
test('service and individual sessions are isolated; only service can retain password, and service cannot write',async()=>{
  const tenant=randomUUID(),a=randomUUID(),b=randomUUID(),operator=id=>({_scope:{kind:'operator',id},remember:true}),service={_scope:{kind:'service'}};
  const one=resolveSessionScope(tenant,'login',operator(a)),two=resolveSessionScope(tenant,'login',operator(b)),job=resolveSessionScope(tenant,'login',service);
  assert.equal(one.input.remember,false);assert.equal(job.input.remember,true);
  assert.equal(new Set([one.key,two.key,job.key]).size,3);
  for(const action of ['commit','change-commit','create-client','preview','clients'])assert.throws(()=>resolveSessionScope(tenant,action,service),e=>e.status===403);
  assert.throws(()=>resolveSessionScope(tenant,'notification-agenda',operator(a)),e=>e.status===403);
  assert.throws(()=>resolveSessionScope(tenant,'status',{}),e=>e.status===409);
  assert.equal(journalTenant(one.key),tenant);assert.equal(journalTenant(job.key),tenant);
  const records=new Map([[`api_${one.key}`,{token:'first',cookies:[],branchId:'1'}],[`api_${two.key}`,{token:'second',cookies:[],branchId:'1'}],[`api_${job.key}`,{token:'automated',cookies:[],branchId:'1'}],[`credentials_${one.key}`,{email:'old',password:'must-not-use'}]]);
  const vault={read:async k=>records.get(k),write:async(k,v)=>records.set(k,v),remove:async k=>records.delete(k)};
  const seen=[],api=new CashApi(null,vault,{fetcher:async(_url,options)=>{seen.push(options.headers.authorization);return Response.json({});}});
  await api.request(one.key,'agendamentos/list',{});await api.request(two.key,'agendamentos/list',{});await api.request(job.key,'agendamentos/list',{});
  assert.deepEqual(seen,['Bearer first','Bearer second','Bearer automated']);
  const operation=randomUUID();records.set('booking_'+tenant+'_'+operation,{state:'confirmed',externalId:'99',message:'Recorded by first operator'});
  assert.equal((await api.perform(two.key,'commit',{operation})).externalId,'99');assert.equal(seen.length,3,'another operator cannot repeat an already recorded write');
  api.connect=()=>assert.fail('Operator cannot automatically log in');assert.equal(await api.renew(one.key),false);
  await api.perform(one.key,'disconnect');assert.ok(await api.session(two.key));assert.ok(await api.session(job.key));assert.equal(records.has('credentials_'+one.key),false);
});
test('explicit account changes discard the previous identity and only the service retains credentials',async t=>{
  const records=new Map(),vault={read:async k=>records.get(k),write:async(k,v)=>records.set(k,v),remove:async k=>records.delete(k)};
  const context={storageState:async()=>({origins:[],cookies:[]}),cookies:async()=>[{name:'access_token_painel',value:'new-account-token'}]},page={on(){},off(){},context:()=>context,evaluate:async()=> '1'};
  t.mock.method(CashConnection.prototype,'page',async function(scope){assert.equal(records.has('session_'+scope),false);assert.equal(records.has('api_'+scope),false);assert.equal(records.has('credentials_'+scope),false);return page;});
  t.mock.method(CashConnection.prototype,'login',async(_scope,_page,input)=>{assert.equal(input.email,'new-account@example.invalid');});
  const api=new CashApi(null,vault);api.directory=async()=>[];
  for(const scope of ['company_user_operator','company_service']){
    for(const prefix of ['session_','api_','credentials_'])records.set(prefix+scope,{old:'identity'});
    await api.connect(scope,{email:'new-account@example.invalid',password:'new-password',remember:true});
    assert.equal(records.get('api_'+scope).token,'new-account-token');assert.equal(records.has('credentials_'+scope),scope.endsWith('_service'));
  }
});
