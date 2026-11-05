import test from 'node:test';
import assert from 'node:assert/strict';
import {CashApi} from '../api.mjs';
import {notificationAppointment,notificationAgenda} from '../notifications.mjs';
test('blocked calendar periods and cancellations without customer IDs never attempt customer lookup',async()=>{
  for(const raw of [{age_tipo:'Bloqueado'},{age_tipo:'Agendamento',age_active:0},{age_tipo:'Agendamento',age_status:'Cancelado'}]){
    const api={branch:async()=> '1',request:async(_t,path)=>{assert.equal(path,'agendamentos/10');return {id:10,age_id_filial:1,age_id_cliente:null,...raw};}};
    assert.deepEqual(await notificationAppointment(api,'tenant','10'),{id:'10',active:false});
  }
});
test('notification feed uses provider creation date, scopes branch and normalizes customer phone',async()=>{
  const api={branch:async()=> '3782',request:async(_t,path)=>path==='agendamentos/list'?{agendamentos:[{id:1},{id:1}]}:path==='clientes/2'?{id:2,cli_name:'Nome no CashBarber',cli_telefone:'(34) 99999-8888',email:'cliente@example.invalid'}:{id:1,age_id_filial:3782,age_id_cliente:2,age_tipo:'Agendamento',age_inicio:'2026-11-04 15:00:00',created_at:'2026-11-02T10:00:00-03:00',agendamento_servicos:[]}};
  assert.deepEqual(await notificationAgenda(api,'a',{date:'2026-11-04'}),{ids:['1']});
  const grouping=await notificationAgenda(api,'a',{date:'2026-11-04',grouping:true});
  assert.equal(grouping.groups.length,2);assert.equal(grouping.groups[0].id,'1');
  const liveFeed={...api,request:async()=>({agendamentos:[{id:1,id_cliente:2,start:'2026-11-04 10:50:00'},{id:3,id_cliente:2,start:'2026-11-04 15:30:00'}]})};
  assert.deepEqual((await notificationAgenda(liveFeed,'a',{date:'2026-11-04',grouping:true})).groups,[{id:'1',clientId:'2',date:'2026-11-04'},{id:'3',clientId:'2',date:'2026-11-04'}]);
  const row=await notificationAppointment(api,'a','1');assert.equal(row.createdAt,Date.parse('2026-11-02T10:00:00-03:00'));assert.equal(row.phone,'5534999998888');assert.equal(row.active,true);assert.equal(row.clientName,'Nome no CashBarber');assert.equal(row.email,'cliente@example.invalid');
  api.branch=async()=> '999';await assert.rejects(notificationAppointment(api,'a','1'),e=>e.status===403);
});
test('authentication renews once for read calls, never retries writes, isolates and deletes credentials',async()=>{
  const records=new Map([['api_a_service',{token:'old',cookies:[],branchId:'1'}],['credentials_a_service',{email:'test',password:'secret'}]]);
  const vault={read:async k=>structuredClone(records.get(k)||null),write:async(k,v)=>records.set(k,v),remove:async k=>records.delete(k)};
  let requests=0,logins=0;
  const api=new CashApi(null,vault,{fetcher:async()=>{requests++;return requests===1?Response.json({},{status:401}):Response.json({ok:true});}});
  api.connect=async(t,input)=>{assert.equal(input.password,'secret');logins++;records.set('api_'+t,{token:'new',cookies:[],branchId:'1'});};
  assert.deepEqual(await api.request('a_service','agendamentos/list',{}),{ok:true});assert.equal(logins,1);assert.equal(requests,2);
  requests=0;await assert.rejects(api.request('a_service','agendamentos',{}),e=>e.status===409);assert.equal(requests,1);assert.equal(logins,1);
  await assert.rejects(api.request('b','agendamentos/list',{}),e=>e.status===409);assert.equal(logins,1);
  await api.perform('a_service','disconnect');assert.equal(records.has('credentials_a_service'),false);assert.equal(records.has('api_a_service'),false);
});
test('failed renewal backs off and can retry even after session removal',async()=>{
  const records=new Map([['api_a_service',{token:'old',cookies:[]}],['credentials_a_service',{email:'test',password:'secret'}]]);
  const vault={read:async k=>structuredClone(records.get(k)||null),write:async(k,v)=>records.set(k,v),remove:async k=>records.delete(k)};
  const api=new CashApi(null,vault,{fetcher:async()=>Response.json({},{status:401})});let logins=0;api.connect=async()=>{logins++;throw Error('Login refused');};
  await assert.rejects(api.request('a_service','agendamentos/list',{}));await assert.rejects(api.request('a_service','agendamentos/list',{}));assert.equal(logins,1);
  records.get('credentials_a_service').retryAfter=0;await assert.rejects(api.request('a_service','agendamentos/list',{}));assert.equal(logins,2);
});
