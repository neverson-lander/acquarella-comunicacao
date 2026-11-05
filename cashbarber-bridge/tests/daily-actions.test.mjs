import test from 'node:test';
import assert from 'node:assert/strict';
import {subscriptionList,subscriptionCustomer,comandaPage,closeComanda} from '../daily-actions.mjs';
import {resolveSessionScope} from '../session-scope.mjs';
const tenant='29ba28cb-8648-48ec-a501-37a8801ebb87';
test('service actions cannot be executed using operator sessions; subscription names alone never identify recipients',async()=>{
 assert.throws(()=>resolveSessionScope(tenant,'daily-close-comanda',{_scope:{kind:'operator',id:tenant}}));
 assert.equal(resolveSessionScope(tenant,'daily-subscriptions',{_scope:{kind:'service'}}).key,tenant+'_service');
 const calls=[],api={request:async(t,path,body)=>{calls.push({path,body});if(path==='clientes/assinaturas')return [{id:8,cli_name:'Maria',clp_dia_cobranca:4,clp_id_plano:3}];if(path==='clientes/simpleList')return [{id:1,cli_name:'Maria'}];return {id:1,cli_name:'Maria',cli_active:1,cli_telefone:'5534999998888',cliente_plano:{id:99,clp_id_cliente:1,clp_id_plano:3}};}};
 assert.equal((await subscriptionList(api,tenant,{date:'2026-11-04'})).items.length,1);
 assert.deepEqual(calls[0].body,{plano:null,data:'2026-11-04',tipo:'manual'});
 assert.equal((await subscriptionCustomer(api,tenant,{id:'8',plan:'3',name:'Maria',date:'2026-11-04'})).active,false);
});
test('closure rechecks branch, age and balance, writes a durable journal before PUT and never repeats an ambiguous write',async()=>{
 const saved=new Map(),writes=[];let paid=false,writeError=null;
 const raw={id:123,com_id_filial:3782,com_pago:0,com_active:1,created_at:'2026-01-01T10:00:00Z',saldo:1250,movimentacoes_registros:[],
  comanda_agendamentos:[{agendamento:{agendamento_servicos:[{id:10,ags_valor:15,ags_desconto:2.50,servico:{id:5}}]}}],
  produtos:[{id:20,cop_valor:5,cop_desconto:5,cop_quantidade:1,produto:{id:6}}]};
 const api={branch:async()=> '3782',vault:{read:async k=>saved.get(k),write:async(k,v)=>saved.set(k,v)},request:async(t,path,body,method)=>{
  if(path==='comandas/123')return {...raw,com_pago:paid?1:0};
  if(path==='caixas/simpleList')return [{id:1,cai_nome:'Caixa',cai_active:1,cai_id_filial:3782}];
  if(path==='financeiro/formas-pagamento/simpleList')return [{id:2,fop_nome:'Outros',fop_nome_predefinido:'OUTROS',fop_tipo:'A VISTA',fop_active:1}];
  if(path==='comandas/fechar/123'){assert.equal(method,'PUT');assert.equal([...saved.values()][0].state,'sending');writes.push(body);if(writeError)throw writeError;paid=true;return {};}
  if(path==='comandas/list')return {data:{data:[raw],last_page:1}};throw Error(path);
 }};
 const input={id:'123',cashbox:'1',payment_method:'2'};
 assert.deepEqual((await comandaPage(api,tenant,{page:0})).ids,['123']);
 assert.equal((await closeComanda(api,tenant,input)).state,'closed');
 assert.deepEqual(writes[0],{
  caixa_id:'1',
  movimentacoes_registros:[{forma_pagamento_id:'2',forma_pagamento:'OUTROS',valor_pagamento:12.50,cartao:''}],
  servicos_com_desconto:[{servico:{id:10,ser_valor:15},desconto:2.50}],
  produtos_com_desconto:[{produto:{...raw.produtos[0],produto:{id:6,pro_valor:5}},desconto:5,quantidade:1}]
 });
 await closeComanda(api,tenant,input);assert.equal(writes.length,1);
 saved.clear();paid=false;writeError=Error('timeout');assert.equal((await closeComanda(api,tenant,input)).state,'uncertain');await closeComanda(api,tenant,input);assert.equal(writes.length,2);
 const [journalKey]=saved.keys();
 saved.set(journalKey,{state:'uncertain',amount:1250,retried:true});
 const retry={...input,retryUnconfirmed:true};
 raw.movimentacoes_registros=[{}];assert.equal((await closeComanda(api,tenant,retry)).state,'uncertain');assert.equal(writes.length,2);
 raw.movimentacoes_registros=[];assert.equal((await closeComanda(api,tenant,retry)).state,'uncertain');
 assert.equal((await closeComanda(api,tenant,retry)).state,'uncertain');assert.equal(writes.length,3);
 saved.clear();writeError=Object.assign(Error('invalid payment'),{providerStatus:422});
 const rejection=await closeComanda(api,tenant,input);assert.equal(rejection.state,'failed');assert.match(rejection.error,/HTTP 422/);
 assert.deepEqual(await closeComanda(api,tenant,input),rejection);assert.equal(writes.length,4);
 saved.clear();raw.com_id_filial=999;await assert.rejects(closeComanda(api,tenant,input));assert.equal(writes.length,4);
});
