import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {CashApi} from '../api.mjs';
import {upcomingAppointments} from '../appointment-changes.mjs';
const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
function fixture(){
 const records=new Map([['api_a',{token:'test-token',cookies:[],branchId:'3782'}]]),calls=[];let exists=true,lost=false,price=40,selfDuplicate=false,otherDuplicate=false;
 const raw={id:99,age_id_cliente:1,age_id_user:2,age_id_filial:3782,age_inicio:date+' 14:00:00',age_fim:date+' 14:50:00',age_tipo:'Agendamento',age_status:'Agendado',age_cliente_status:'Aguardando',age_active:1,age_observacao:'Preservar observação',age_sem_preferencia:false,updated_at:'version-1',cliente:{cli_name:'Cliente'},user:{usu_name:'Ana'},agendamento_servicos:[{ags_id_servico:7,ags_valor:40,servico:{ser_nome:'Serviço A'}},{ags_id_servico:8,ags_valor:10,servico:{ser_nome:'Serviço B'}}]};
 const vault={read:async k=>structuredClone(records.get(k)||null),write:async(k,v)=>records.set(k,structuredClone(v)),remove:async k=>records.delete(k)};
 const fetcher=async(url,options)=>{const path=url.split('/api/painel/')[1],body=options.body?JSON.parse(options.body):null;calls.push({path,method:options.method,body});
  if(path==='agendamentos/99'){
   if(options.method==='PUT'){raw.age_inicio=body.age_inicio;raw.age_fim=body.age_fim;raw.age_id_user=body.age_id_user;raw.updated_at='version-2';raw.agendamento_servicos=body.servicos.map(id=>({ags_id_servico:id,ags_valor:id===7?price:10,servico:{ser_nome:id===7?'Serviço A':'Serviço B'}}));if(lost)throw Error('Lost response');return Response.json({id:99});}
   if(options.method==='DELETE'){assert.equal(options.headers['content-type'],undefined,'DELETE without a body must not declare JSON content');exists=false;if(lost)throw Error('Lost response');return new Response(null,{status:204,headers:{'set-cookie':'access_token_painel=rotated-after-delete; Path=/; Max-Age=3600'}});}
   return exists?Response.json(raw):Response.json({message:'Not found'},{status:404});
  }
  if(path==='usuarios/simpleListBarbeirosAtivos')return Response.json([{id:2,usu_name:'Ana',user_servicos:[{uss_id_servico:7},{uss_id_servico:8}]}]);
  if(path==='servicos/list')return Response.json({data:{data:[{id:7,ser_nome:'Serviço A',ser_active:1,ser_duracao:30,ser_valor:price},{id:8,ser_nome:'Serviço B',ser_active:1,ser_duracao:20,ser_valor:10}],last_page:1}});
  if(path==='clientes/servico/preco')return Response.json(body.servico_id===7?price:10);
  if(path==='agendamentos/check'){assert.equal(body.age_id,99);return Response.json({indisponivel:false,duplicado:selfDuplicate?{age_inicio:raw.age_inicio}:false,inadimplente:false,intervalo:false});}
  if(path==='agendamentos/list')return Response.json({barbeiros:[{id:2}],min:date+' 08:00:00',max:date+' 20:00:00',horarios:[{id_barbeiro:2,entrada:date+' 09:00:00',saida:date+' 18:00:00'}],intervalos:[],folgas:[],agendamentos:exists?[{id:99,id_cliente:1,id_barbeiro:2,start:raw.age_inicio,end:raw.age_fim,agendamento_servicos:raw.agendamento_servicos},...(otherDuplicate?[{id:100,id_cliente:1,id_barbeiro:2,start:date+' 10:00:00',end:date+' 10:50:00',agendamento_servicos:raw.agendamento_servicos}]:[])]:[]});
  throw Error(path);
 };
 return {api:new CashApi(null,vault,{fetcher}),vault,fetcher,calls,raw,setLost:v=>lost=v,setPrice:v=>price=v,setSelfDuplicate:v=>selfDuplicate=v,setOtherDuplicate:v=>otherDuplicate=v};
}
const update={kind:'update',id:'99',clientId:'1',professionalId:'2',services:['7','8'],date,start:'14:00'};
test('update excludes its own slot, preserves multiple services and notes, and verifies historical prices',async()=>{
 const f=fixture(),preview=await f.api.perform('a','change-preview',update);assert.equal(preview.available,true);assert.equal(preview.after.price,5000);assert.equal(preview.after.end,'14:50');
 const result=await f.api.perform('a','change-commit',{operation:randomUUID(),preview});assert.equal(result.state,'confirmed');assert.equal(result.after.services.length,2);
 const write=f.calls.find(c=>c.method==='PUT');assert.deepEqual(write.body.servicos,[7,8]);assert.equal(write.body.age_observacao,'Preservar observação');assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('lost update response and restart reconcile without repeating PUT; changed snapshot blocks write',async()=>{
 const f=fixture(),preview=await f.api.perform('a','change-preview',{...update,start:'16:00'}),operation=randomUUID();f.setLost(true);
 assert.equal((await f.api.perform('a','change-commit',{operation,preview})).state,'uncertain');
 const restarted=new CashApi(null,f.vault,{fetcher:f.fetcher});assert.equal((await restarted.perform('a','change-commit',{operation,preview})).state,'confirmed');assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
 const g=fixture(),stale=await g.api.perform('a','change-preview',update);g.raw.updated_at='changed-elsewhere';assert.equal((await g.api.perform('a','change-commit',{operation:randomUUID(),preview:stale})).state,'rejected');assert.equal(g.calls.filter(c=>c.method==='PUT').length,0);
});
test('DELETE 204 and subsequent GET 404 confirm exclusion once; another client and finalized bookings are blocked',async()=>{
 const f=fixture();await assert.rejects(f.api.perform('a','appointment',{id:'99',clientId:'2'}),e=>e.status===403);
 const preview=await f.api.perform('a','change-preview',{kind:'cancel',id:'99',clientId:'1'}),operation=randomUUID();assert.equal((await f.api.perform('a','change-commit',{operation,preview})).state,'confirmed');assert.equal((await f.api.perform('a','change-commit',{operation,preview})).state,'confirmed');assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);assert.equal((await f.vault.read('api_a')).token,'rotated-after-delete');
 const g=fixture();g.raw.age_status='Finalizado';await assert.rejects(g.api.perform('a','change-preview',{kind:'cancel',id:'99',clientId:'1'}),e=>e.status===409);assert.equal(g.calls.filter(c=>c.method==='DELETE').length,0);
});
test('price changes and open comanda reject before writing; uncertain deletion remains read-only on recovery',async()=>{
 const f=fixture(),preview=await f.api.perform('a','change-preview',update);f.setPrice(55);assert.equal((await f.api.perform('a','change-commit',{operation:randomUUID(),preview})).state,'rejected');assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
 const g=fixture();g.raw.comanda_agendamento={comanda:{id:1,com_active:1,com_pago:0}};await assert.rejects(g.api.perform('a','change-preview',{kind:'cancel',id:'99',clientId:'1'}),/comanda aberta/);
 const h=fixture(),cancel=await h.api.perform('a','change-preview',{kind:'cancel',id:'99',clientId:'1'}),operation=randomUUID();h.setLost(true);assert.equal((await h.api.perform('a','change-commit',{operation,preview:cancel})).state,'uncertain');assert.equal((await h.api.perform('a','change-reconcile',{operation})).state,'confirmed');assert.equal(h.calls.filter(c=>c.method==='DELETE').length,1);
});

test('provider self-duplicate is verified by ID; other bookings require a stable reviewed warning',async()=>{
 const f=fixture();f.setSelfDuplicate(true);const preview=await f.api.perform('a','change-preview',{...update,start:'16:00'});assert.equal((await f.api.perform('a','change-commit',{operation:randomUUID(),preview})).state,'confirmed');
 const g=fixture();g.setSelfDuplicate(true);g.setOtherDuplicate(true);const second=await g.api.perform('a','change-preview',{...update,start:'16:00'});assert.equal(second.warnings.length,1);assert.equal((await g.api.perform('a','change-commit',{operation:randomUUID(),preview:second})).state,'confirmed');
 const h=fixture(),withoutWarning=await h.api.perform('a','change-preview',{...update,start:'16:00'});h.setSelfDuplicate(true);h.setOtherDuplicate(true);assert.equal((await h.api.perform('a','change-commit',{operation:randomUUID(),preview:withoutWarning})).state,'rejected');assert.equal(h.calls.filter(c=>c.method==='PUT').length,0);
});

test('busy edit start still returns free slots for selection and cannot be committed',async()=>{
 const f=fixture(),original=f.api.fetcher;f.api.fetcher=async(url,options)=>url.endsWith('/agendamentos/check')?Response.json({indisponivel:true,duplicado:false,inadimplente:false,intervalo:false}):original(url,options);
 const preview=await f.api.perform('a','change-preview',{...update,start:'16:00'});assert.equal(preview.available,false);assert.ok(preview.slots.length>0);assert.match(preview.reason,/horários livres/);assert.equal((await f.api.perform('a','change-commit',{operation:randomUUID(),preview})).state,'rejected');assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
});

test('upcoming list is client scoped, future only, bounded, sorted and sanitized',async()=>{
 const event=(id,extra={})=>({id,id_cliente:1,id_barbeiro:2,start:date+'T14:00:00',age_status:'Agendado',agendamento_servicos:[{ags_id_servico:7,servico:{ser_nome:'Serviço'}}],...extra});
 const calls=[],api={branch:async()=>'3782',request:async(t,path,body)=>{calls.push({path,body});if(path==='clientes/1')return {id:1,cli_name:'Cliente',remember_token:'private'};return {barbeiros:[{id:2,usu_name:'Ana'}],agendamentos:[event(1,{start:date+'T16:00:00'}),event(2),event(3,{id_cliente:9}),event(4,{age_status:'Finalizado'}),event(5,{start:'2000-01-01T14:00:00'}),event(6,{age_status:'Cancelado'})]};}};
 const result=await upcomingAppointments(api,'a',{clientId:'1'});assert.deepEqual(result.appointments.map(a=>a.id),['2','1']);assert.equal(result.hasMore,false);assert.ok(!JSON.stringify(result).includes('private'));assert.equal(calls.find(c=>c.path==='agendamentos/list').body.id_filial,'3782');assert.ok(result.until>result.from);
});
