import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignAutoBookings} from '../campaign-customer.mjs';
const input={channel:'whatsapp',phone:'5534984411948',from:'2026-10-01',to:'2026-12-31',since:Date.parse('2026-10-01T10:00:00-03:00'),until:Date.parse('2026-10-22T23:00:00-03:00')};
function fixture(customers){
 const calls=[],api={branch:async()=> '9',customer:async(t,id)=>({id,name:'Maria'}),request:async(t,path,body)=>{assert.equal(t,'company');calls.push({path,body});if(path==='clientes/simpleList')return customers.map(c=>({id:c.id,cli_name:c.cli_name}));if(path==='clientes/list')return {data:{data:customers.map(c=>({id:c.id})),last_page:1}};if(path.startsWith('clientes/'))return customers.find(c=>'clientes/'+c.id===path);if(path==='agendamentos/list')return {agendamentos:[{id:99,id_cliente:7,id_barbeiro:2}],barbeiros:[{id:2,usu_name:'Ana'}]};if(path==='agendamentos/99')return {id:99,age_id_cliente:7,age_id_filial:9,created_at:'2026-10-03T13:00:00Z',age_inicio:'2026-12-01 14:00:00',agendamento_servicos:[{ags_id_servico:1,ags_valor:'45.50',servico:{ser_nome:'Manicure'}},{ags_id_servico:2,ags_valor:0,servico:{ser_nome:'Pedicure no plano'}}]};throw Error(path);}};return {api,calls};
}
test('automatic WhatsApp search verifies the phone and saves actual booked service values, including zero',async()=>{
 const {api,calls}=fixture([{id:7,cli_name:'Maria',cli_telefone:'(34) 98441-1948'},{id:8,cli_name:'Homônima',cli_telefone:'(34) 99999-9999'}]);
 const r=await campaignAutoBookings(api,'company',input);assert.equal(calls[0].body.termo,'(34) 98441-1948');assert.equal(r.status,'matched');assert.equal(r.client_id,'7');assert.equal(r.matches[0].amount_cents,4550);assert.equal(r.total_amount_cents,4550);assert.deepEqual(r.matches[0].service_details.map(s=>s.price_cents),[4550,0]);assert.ok(calls.every(c=>c.path!=='agendamentos'));
});
test('Instagram can match by email; duplicated matches are never chosen automatically',async()=>{
 const f=fixture([{id:7,cli_name:'Maria',email:'MARIA@EXAMPLE.COM',cli_telefone:''}]);assert.equal((await campaignAutoBookings(f.api,'company',{...input,channel:'instagram',phone:'',email:'maria@example.com'})).status,'matched');assert.equal(f.calls[0].path,'clientes/list');assert.equal(f.calls[0].body.globalFilter,'maria@example.com');
 const dup=fixture([{id:7,cli_telefone:input.phone},{id:8,cli_telefone:input.phone}]);assert.equal((await campaignAutoBookings(dup.api,'company',input)).status,'ambiguous_client');assert.ok(!dup.calls.some(c=>c.path==='agendamentos/list'));
 const missing=fixture([]);assert.equal((await campaignAutoBookings(missing.api,'company',{...input,channel:'instagram',phone:'',email:''})).status,'missing_contact');assert.equal(missing.calls.length,0);
 const unknown=fixture([{id:7,cli_name:'Maria',cli_telefone:'11988887777'}]);assert.equal((await campaignAutoBookings(unknown.api,'company',input)).status,'client_not_found');
});

test('legacy WhatsApp mobile numbers search with the ninth digit while matching the original customer identity',async()=>{
 for(const phone of ['553484411948','3484411948','(34) 8441-1948']){
  const f=fixture([{id:7,cli_name:'Maria',cli_telefone:'(34) 98441-1948'}]);
  const result=await campaignAutoBookings(f.api,'company',{...input,phone});
  assert.equal(f.calls[0].body.termo,'(34) 98441-1948');assert.equal(result.client_id,'7');assert.equal(result.status,'matched');
 }
 const fixed=fixture([]);await campaignAutoBookings(fixed.api,'company',{...input,phone:'553432111234'});assert.equal(fixed.calls[0].body.termo,'(34) 3211-1234');
});


test('paid campaign lookup searches both exact phone spellings and deduplicates returned customer IDs',async()=>{
 for(const channel of ['whatsapp','instagram'])for(const phone of ['5534984411948','553484411948'])for(const stored of ['(34) 98441-1948','(34) 8441-1948']){
  const f=fixture([{id:7,cli_name:'Maria',cli_telefone:stored}]),original=f.api.request,terms=[];
  f.api.request=async(t,path,body)=>{if(path==='clientes/simpleList'){terms.push(body.termo);return body.termo===stored?[{id:7}]:[];}return original(t,path,body);};
  const report=await campaignAutoBookings(f.api,'company',{...input,channel,phone});
  assert.equal(report.status,'matched');assert.equal(report.client_id,'7');assert.deepEqual(new Set(terms),new Set(['(34) 98441-1948','(34) 8441-1948']));assert.equal(f.calls.filter(c=>c.path==='clientes/7').length,1);
 }
});
