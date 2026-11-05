import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CashApi} from '../api.mjs';
import {customerInput} from '../customers.mjs';

const details={name:'Cliente teste',phone:'(34) 99999-8888',email:'cliente@test.invalid',password:'test-only-password',birthDate:'1990-02-10',source:'Instagram'};
function fixture(){
 const records=new Map([['api_a',{token:'test-token',cookies:[],branchId:'1'}]]),calls=[];let written=false,lost=false,existing=false,ambiguous=false;
 const vault={read:async k=>structuredClone(records.get(k)||null),write:async(k,v)=>records.set(k,structuredClone(v)),remove:async k=>records.delete(k)};
 const row={id:123,cli_name:details.name,cli_telefone:details.phone,email:details.email,cli_active:1,remember_token:'never-return',cli_google_refresh_token:'never-return'};
 const api=new CashApi(null,vault,{fetcher:async(url,options)=>{
  const path=url.split('/api/painel/')[1],body=options.body?JSON.parse(options.body):null;calls.push({path,body,method:options.method});
  if(path==='clientes/list')return Response.json({data:{data:written||existing?[row,...(ambiguous?[{...row,id:124}]:[])]:[],last_page:1,current_page:1,total:written||existing?1:0}});
  if(path==='clientes/123')return Response.json(row);
  if(path==='clientes'){written=true;if(lost)throw Error('lost response');return Response.json({id:123});}
  throw Error('Unexpected '+path);
 }});
 return {api,vault,calls,records,setLost:v=>lost=v,setExisting:v=>existing=v,setAmbiguous:v=>ambiguous=v};
}
test('customer pagination returns only directory fields and rejects malformed pagination',async()=>{
 const f=fixture();f.setExisting(true);const result=await f.api.perform('a','customer-page',{page:0});assert.equal(result.clients.length,1);assert.equal(result.total,1);assert.ok(!JSON.stringify(result).includes('never-return'));
 assert.equal(f.calls[0].body.rows,100);await assert.rejects(f.api.perform('a','customer-page',{page:-1}));
 f.api.fetcher=async()=>Response.json({data:{data:[],last_page:2,current_page:1,total:2}});await assert.rejects(f.api.perform('a','customer-page',{page:1}),e=>e.status===502);
});
test('customer creation validates, checks duplicates, posts once and confirms by reading back',async()=>{
 const f=fixture(),operation=randomUUID(),result=await f.api.perform('a','create-client',{...details,operation});
 assert.equal(result.state,'confirmed');assert.equal(result.client.id,'123');assert.equal(f.calls.filter(c=>c.path==='clientes').length,1);
 const body=f.calls.find(c=>c.path==='clientes').body;assert.equal(body.cli_telefone,details.phone);assert.equal(body.cli_name,details.name);assert.equal(body.cli_data_nascimento,details.birthDate);
 const restarted=new CashApi(null,f.vault,{fetcher:()=>{throw Error('Replay must not write or query');}});
 assert.equal((await restarted.perform('a','create-client',{...details,operation})).client.id,'123');
 assert.ok(!JSON.stringify([...f.records.values()]).includes(details.password));assert.ok(!JSON.stringify(result).includes('never-return'));
 await assert.rejects(f.api.perform('a','create-client',{...details,name:'Changed',operation}),e=>e.status===409);
 assert.throws(()=>customerInput({...details,birthDate:'2020-02-30'}));assert.throws(()=>customerInput({...details,email:''}));assert.throws(()=>customerInput({...details,phone:'123'}));
});
test('duplicates block creation; response loss and a new operation reconcile without a second POST',async()=>{
 const f=fixture();f.setExisting(true);await assert.rejects(f.api.perform('a','create-client',{...details,operation:randomUUID()}),e=>e.status===409);assert.equal(f.calls.filter(c=>c.path==='clientes').length,0);
 f.setExisting(false);f.setLost(true);const operation=randomUUID();await assert.rejects(f.api.perform('a','create-client',{...details,operation}),e=>e.status===409);
 const restarted=new CashApi(null,f.vault,{fetcher:f.api.fetcher});assert.equal((await restarted.perform('a','create-client',{...details,operation:randomUUID()})).state,'confirmed');assert.equal(f.calls.filter(c=>c.path==='clientes').length,1);
});
test('ambiguous reconciliation stays pending and never repeats customer creation',async()=>{
 const f=fixture();f.setLost(true);const operation=randomUUID();await assert.rejects(f.api.perform('a','create-client',{...details,operation}));f.setAmbiguous(true);
 await assert.rejects(f.api.perform('a','create-client',{...details,operation}),e=>e.status===409);assert.equal(f.calls.filter(c=>c.path==='clientes').length,1);
});


test('manual client lookup and duplicate prevention search both forms before creating a customer',async()=>{
 for(const phone of ['(34) 98441-1948','(34) 8441-1948']){
  const f=fixture(),terms=[];f.api.request=async(_t,path,body)=>{
   if(path==='clientes/simpleList'){terms.push(body.termo);return body.termo==='(34) 98441-1948'?[{id:7,cli_name:'Existente',cli_telefone:body.termo}]:[];}
   if(path==='clientes/list'){terms.push(body.globalFilter);return {data:{data:body.globalFilter==='(34) 98441-1948'?[{id:7,cli_name:'Existente',cli_telefone:'(34) 98441-1948',email:'other@test.invalid'}]:[],last_page:1,current_page:1,total:1}};}
   throw Error('No customer write is allowed');
  };
  const result=await f.api.perform('a','clients',{search:phone});assert.equal(result.clients.length,1);assert.equal(result.clients[0].id,'7');assert.ok(terms.includes('(34) 8441-1948'));
  await assert.rejects(f.api.perform('a','create-client',{...details,phone,email:'new@test.invalid',operation:randomUUID()}),e=>e.status===409);assert.equal(f.calls.filter(c=>c.path==='clientes').length,0);
 }
});
