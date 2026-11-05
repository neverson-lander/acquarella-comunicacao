import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CashApi} from '../api.mjs';
import {apiCalendar} from '../api-calendar.mjs';

const date=new Date(Date.now()+86400000).toISOString().slice(0,10);
function fixture(){
  const records=new Map(),calls=[];let written=false,price=45,failSave=false,invalidEvent=false;
  const session={token:'private-token',cookies:[{name:'access_token_painel',value:'private-cookie'}],branchId:'3782'};
  records.set('api_a',session);records.set('api_b',{...session,token:'other-token'});
  const vault={read:async k=>structuredClone(records.get(k)||null),write:async(k,v)=>records.set(k,structuredClone(v)),remove:async k=>records.delete(k)};
  const event={id:99,id_cliente:1,id_barbeiro:2,start:date+'T14:00:00',end:date+'T14:50:00',agendamento_servicos:[{ags_id_servico:7,servico:{id:7,ser_nome:'Manicure'}}]};
  const schedule=()=>({min:date+' 08:00:00',max:date+' 21:00:00',filiais:[{id:3782}],barbeiros:[{id:2,usu_name:'Ana'}],horarios:[{id_barbeiro:2,entrada:date+'T09:00:00',saida:date+'T18:00:00'}],agendamentos:written?[event]:[],intervalos:[{id_barbeiro:2,start:invalidEvent?'unknown':date+'T12:00:00',end:date+'T13:00:00',classNames:'break'}],folgas:[]});
  const fetcher=async(url,options)=>{
    const path=new URL(url).pathname.replace('/api/painel/',''),body=options.body?JSON.parse(options.body):undefined;
    calls.push({path,body,options});assert.equal(options.redirect,'error');assert.equal(options.headers.cookie,'access_token_painel=private-cookie');
    if(path==='usuarios/simpleListBarbeirosAtivos')return Response.json([{id:2,usu_name:'Ana',user_servicos:[{id:77,uss_id_servico:7,uss_duracao_personalizada:50,uss_valor_personalizado:49},{id:88,uss_id_servico:8}]}]);
    if(path==='servicos/list')return Response.json({data:{data:[{id:7,ser_nome:'Manicure',ser_active:1,ser_duracao:30,ser_valor:40},{id:8,ser_nome:'Inativo',ser_active:0,ser_duracao:20,ser_valor:10}],last_page:1}});
    if(path==='agendamentos/list')return Response.json(schedule());
    if(path==='agendamentos/99')return Response.json({id:99,age_id_cliente:1,age_id_filial:3782,age_inicio:date+' 14:00:00',created_at:new Date().toISOString(),agendamento_servicos:event.agendamento_servicos});
    if(path==='clientes/simpleList')return Response.json([{id:1,cli_name:'Cliente',cli_telefone:'11999999999',email:'private@example.invalid'}]);
    if(path==='clientes/1')return Response.json({id:1,cli_name:'Cliente',cli_telefone:'11999999999',assinaturas:[{ativa:1,plano:'Plano'}],cartoes:[{secret:'never-return'}]});
    if(path==='clientes/historico-curto/1')return Response.json([{id:5,age_inicio:date+' 09:00:00',age_status:'Agendado',user:{usu_name:'Ana'},agendamento_servicos:[{servico:{ser_nome:'Manicure'}}]}]);
    if(path==='clientes/servico/preco')return Response.json(price);
    if(path==='agendamentos/check')return Response.json({indisponivel:false,duplicado:false,inadimplente:false,intervalo:false});
    if(path==='agendamentos'){assert.equal(records.get([...records.keys()].find(k=>k.startsWith('booking_')))?.state,'pending');written=true;if(failSave)throw Error('Connection lost after provider accepted');return Response.json({id:99});}
    throw Error('Unexpected path: '+path);
  };
  const api=new CashApi(null,vault,{fetcher});api.page=()=>{throw Error('Operational calls must never open a browser');};
  return {api,records,calls,vault,schedule,setPrice:v=>price=v,setFailSave:v=>failSave=v,setInvalid:v=>invalidEvent=v};
}
const details={clientId:'1',professionalId:'2',service:'7',date,start:'14:00'};

test('existing appointment lookup reads the selected day and client without creating a reservation',async()=>{
 const f=fixture();
 const preview=await f.api.perform('a','preview',details);
 await f.api.perform('a','commit',{operation:randomUUID(),quote:preview.quote});
 f.calls.length=0;
 const result=await f.api.perform('a','appointments',{client_id:'1',date});
 assert.deepEqual(result.appointments,[{id:'99',client_id:'1',client_name:'Cliente',professional_id:'2',professional:'Ana',date,start:'14:00',status:'',services:[{id:'7',name:'Manicure'}]}]);
 assert.ok(f.calls.every(c=>c.path!=='agendamentos'&&c.path!=='agendamentos/check'));
 assert.ok(!JSON.stringify(result).includes('private'));
 await assert.rejects(f.api.perform('a','appointments',{client_id:'1',date:'2026-02-30'}));
 f.api.customer=async()=>({name:'Outro cliente'});
 assert.deepEqual(await f.api.perform('a','appointments',{client_id:'9',date}),{appointments:[]});
});

test('campaign lookup uses authenticated API requests and creation details without browser navigation or writes',async()=>{
 const f=fixture(),preview=await f.api.perform('a','preview',details);await f.api.perform('a','commit',{operation:randomUUID(),quote:preview.quote});f.calls.length=0;
 const report=await f.api.perform('a','campaign-bookings',{client_id:'1',from:date,to:date,since:Date.now()-86400000,until:Date.now()+1000});
 assert.equal(report.status,'matched');assert.equal(report.matches[0].id,'99');assert.ok(f.calls.some(c=>c.path==='agendamentos/99'&&c.options.method==='GET'));assert.ok(f.calls.every(c=>c.path!=='agendamentos'&&c.path!=='agendamentos/check'));assert.ok(!JSON.stringify(report).includes('private'));
});

test('API directory joins active service IDs and applies professional overrides without browser navigation',async()=>{
  const {api,calls}=fixture();assert.deepEqual((await api.perform('a','professionals')).professionals,[{id:'2',name:'Ana'}]);
  const services=(await api.perform('a','services',{id:'2'})).services;
  assert.deepEqual(services,[{id:'7',name:'Manicure',duration:50,price:4900}]);
  assert.equal(calls[0].body.id_filial,3782);
  assert.equal(calls[0].options.headers.authorization,'Bearer private-token');
  await api.perform('a','professionals');assert.equal(calls.filter(c=>c.path==='servicos/list').length,1);
  await api.perform('a','professionals',{refresh:true});assert.equal(calls.filter(c=>c.path==='servicos/list').length,2);
});

test('API quote uses customer price and catalog ID, preserves duration, blocks and limited history',async()=>{
  const {api,calls}=fixture();const customer=(await api.perform('a','client',{id:'1'})).client;
  assert.equal(customer.history.length,1);assert.equal(customer.plan,'Plano');assert.ok(!JSON.stringify(customer).includes('never-return'));
  const search=await api.perform('a','clients',{search:'Cliente'});assert.deepEqual(search.clients,[{id:'1',name:'Cliente',phone:'11999999999'}]);assert.ok(!JSON.stringify(search).includes('private@example.invalid'));
  const preview=await api.perform('a','preview',details);
  assert.equal(preview.quote.price,4500);assert.equal(preview.quote.serviceId,'7');assert.equal(preview.quote.service,'Manicure');assert.equal(preview.quote.end,'14:50');
  assert.equal(preview.available,true);assert.ok(!preview.slots.includes('11:15'));assert.ok(!preview.slots.includes('12:30'));assert.ok(!('events' in preview));
  assert.deepEqual(calls.find(c=>c.path==='clientes/servico/preco').body,{cli_id:1,servico_id:7,age_inicio:date,usu_id:2});
  assert.ok(!JSON.stringify(preview).includes('private-token'));
});

test('API commit persists intent, sends once and reconciles by IDs; restart cannot duplicate it',async()=>{
  const {api,vault,calls}=fixture(),operation=randomUUID(),preview=await api.perform('a','preview',details);
  const result=await api.perform('a','commit',{operation,quote:preview.quote});
  assert.equal(result.state,'confirmed');assert.equal(result.externalId,'99');
  const save=calls.find(c=>c.path==='agendamentos');assert.equal(save.options.method,'POST');assert.deepEqual(save.body.servicos,[7]);assert.equal(save.body.age_id_cliente,1);
  const restarted=new CashApi(null,vault,{fetcher:()=>{throw Error('Replay must not make external requests');}});
  assert.equal((await restarted.perform('a','commit',{operation,quote:preview.quote})).externalId,'99');
  assert.equal(calls.filter(c=>c.path==='agendamentos').length,1);
});

test('elapsed same-day start returns future availability without allowing confirmation in the past',async context=>{
 const {api,calls}=fixture();context.mock.method(Date,'now',()=>Date.parse(date+'T14:10:00-03:00'));
 const result=await api.perform('a','preview',details);
 assert.equal(result.elapsedStart,true);assert.equal(result.available,false);assert.ok(result.slots.length>0);assert.ok(result.slots.every(t=>t>'14:10'));
 const confirmation=await api.perform('a','commit',{operation:randomUUID(),quote:result.quote});
 assert.equal(confirmation.state,'rejected');assert.match(confirmation.message,/início selecionado já passou/);assert.equal(calls.filter(c=>c.path==='agendamentos').length,0);
});

test('price changes reject before sending and lost responses remain uncertain until read-only reconciliation',async()=>{
  const f=fixture(),preview=await f.api.perform('a','preview',details);f.setPrice(55);
  assert.equal((await f.api.perform('a','commit',{operation:randomUUID(),quote:preview.quote})).state,'rejected');
  assert.equal(f.calls.filter(c=>c.path==='agendamentos').length,0);
  f.setPrice(45);f.setFailSave(true);const operation=randomUUID();
  assert.equal((await f.api.perform('a','commit',{operation,quote:preview.quote})).state,'uncertain');
  assert.equal((await f.api.perform('a','commit',{operation,quote:preview.quote})).state,'uncertain');
  assert.equal((await f.api.perform('a','reconcile',{operation})).state,'confirmed');
  assert.equal(f.calls.filter(c=>c.path==='agendamentos').length,1);
});

test('API calendar never offers malformed, missing or off-shift availability and does not export customer data',()=>{
  const {schedule}=fixture(),data=schedule();
  data.horarios.push({id_barbeiro:2,entrada:date+'T19:00:00',saida:date+'T20:00:00'});
  const people=[{id:'2',name:'Ana'},{id:'3',name:'Outra'}],calendar=apiCalendar(data,date,people,0);
  assert.deepEqual(calendar.professionals[0].windows,[{start:'09:00',end:'12:00'},{start:'13:00',end:'18:00'},{start:'19:00',end:'20:00'}]);
  assert.ok(calendar.professionals[1].error);
  data.intervalos[0].start='invalid';assert.equal(apiCalendar(data,date,people,0).professionals[0].windows.length,0);
  data.intervalos[0].id_barbeiro=null;assert.throws(()=>apiCalendar(data,date,people,0));
});

test('multi-day leave blocks the whole shift and overlapping shifts do not duplicate availability',()=>{
  const {schedule}=fixture(),data=schedule(),people=[{id:'2',name:'Ana'}];
  data.folgas=[{id_barbeiro:2,start:'2000-01-01 00:00:00',end:'2099-01-01 00:00:00',classNames:'break'}];
  assert.deepEqual(apiCalendar(data,date,people,0).professionals[0].windows,[]);
  data.folgas=[];data.horarios.push({...data.horarios[0]});
  assert.equal(apiCalendar(data,date,people,0).professionals[0].windows.length,2);
});

test('expired authentication returns disconnected and tenant sessions remain isolated',async()=>{
  const {api,records}=fixture();api.fetcher=async(_,options)=>{assert.equal(options.headers.authorization,'Bearer other-token');return Response.json({message:'Expired'},{status:401});};
  assert.equal((await api.perform('b','status')).connected,false);
  await assert.rejects(api.perform('b','professionals'),e=>e.status===409);
  assert.equal(records.get('api_a').token,'private-token');
  await api.perform('b','disconnect');assert.ok(!records.has('api_b'));assert.ok(records.has('api_a'));
});

test('existing encrypted browser session migrates to API credentials without browser navigation',async()=>{
  const {api,records}=fixture();records.delete('api_a');records.set('session_a',{cookies:[{name:'access_token_painel',value:'migrated-token',domain:'.cashbarber.com.br',expires:-1}]});api.branchId='3782';
  assert.equal((await api.session('a')).token,'migrated-token');assert.equal(records.get('api_a').branchId,'3782');
});

test('rotated tokens and cookies persist together and survive connector restart',async()=>{
  const {api,records,vault}=fixture();api.fetcher=async()=>Response.json([],{headers:{'set-cookie':'access_token_painel=rotated-token; Path=/; Max-Age=3600; Secure; HttpOnly'}});
  await api.request('a','clientes/simpleList',{termo:'Cliente'});
  assert.equal(records.get('api_a').token,'rotated-token');assert.ok(records.get('api_a').cookies[0].expires>Date.now()/1000);
  const restarted=new CashApi(null,vault,{fetcher:async(_,options)=>{assert.equal(options.headers.authorization,'Bearer rotated-token');assert.equal(options.headers.cookie,'access_token_painel=rotated-token');return Response.json([]);}});
  await restarted.request('a','clientes/simpleList',{termo:'Cliente'});
  assert.equal(records.get('api_b').token,'other-token');
});

test('branch migration recovers the provider identity from an existing encrypted login without navigation',async()=>{
  const {api,records}=fixture();records.get('api_a').branchId=null;
  records.set('session_a',{origins:[{origin:'https://painel.cashbarber.com.br',localStorage:[{name:'persist:app-auth',value:JSON.stringify({me:JSON.stringify({identity:{usu_id_filial:3782}})})}]}]});
  assert.equal((await api.session('a')).branchId,'3782');assert.equal(records.get('api_a').branchId,'3782');assert.equal(records.get('api_a').token,'private-token');
});


test('appointment ranges span dates, scope the client, omit cancellations and validate the period before requesting',async()=>{
 const f=fixture(),from='2026-10-20',to='2027-10-20';
 const event=(id,date,extra={})=>({id,id_cliente:1,id_barbeiro:2,start:date+'T14:00:00',agendamento_servicos:[{ags_id_servico:7,servico:{ser_nome:'Manicure'}}],...extra});
 f.api.customer=async()=>({name:'Cliente'});
 f.api.request=async(tenant,path,body)=>{if(path==='agendamentos/list'){assert.equal(body.data_inicio,from+' 00:00:00');assert.equal(body.data_fim,to+' 23:59:59');return {barbeiros:[{id:2,usu_name:'Ana'}],agendamentos:[event(2,'2027-01-10'),event(1,from),event(3,'2026-10-19'),event(4,from,{id_cliente:9}),event(5,from,{age_status:'Cancelado'}),event(6,from,{age_active:0}),event(7,'2027-10-21'),event(8,'2026-10-22',{age_status:'Finalizado'})]};}throw Error(path)};
 const result=await f.api.perform('a','appointments',{client_id:'1',from,to});
 assert.deepEqual(result.appointments.map(a=>a.id),['1','8','2']);assert.equal(result.from,from);assert.equal(result.to,to);
 for(const period of [{from,to:'2026-10-19'},{from,to:'2028-10-20'},{from:'2026-02-30',to},{from},{to}])await assert.rejects(f.api.perform('a','appointments',{client_id:'1',...period}),e=>e.status===400);
});
