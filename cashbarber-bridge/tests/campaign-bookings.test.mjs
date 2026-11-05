import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignBookings,creationTimestamp,consultationRange} from '../campaign-bookings.mjs';
const since=Date.parse('2026-10-01T10:00:00-03:00'),until=Date.parse('2026-10-22T23:00:00-03:00');
const input={client_id:'7',from:'2026-10-01',to:'2026-12-31',since,until};
function fixture(details){
 const calls=[],events=details.map(d=>({id:d.id,id_cliente:7,id_barbeiro:2,start:'2026-12-01T14:00:00',agendamento_servicos:[{servico:{ser_nome:'Manicure'}}]}));
 const api={customer:async(t,id)=>{assert.equal(t,'tenant');assert.equal(id,'7');return {name:'Maria'};},branch:async()=> '9',request:async(t,path,body)=>{calls.push({tenant:t,path,body});if(path==='agendamentos/list')return {agendamentos:[...events,{id:999,id_cliente:88}],barbeiros:[{id:2,usu_name:'Ana'}]};const d=details.find(d=>'agendamentos/'+d.id===path);return {age_id_cliente:7,age_id_filial:9,age_inicio:'2026-12-01 14:00:00',...d};}};
 return {api,calls};
}
test('campaign comparison uses creation, excludes old reservations with future service dates, and reads only selected customer details',async()=>{
 const {api,calls}=fixture([{id:1,created_at:'2026-09-30T10:00:00-03:00'},{id:2,created_at:'2026-10-01T10:00:00-03:00'},{id:3,created_at:'2026-10-02T13:00:00Z'},{id:4,created_at:'2026-10-23T13:00:00Z'}]);
 const report=await campaignBookings(api,'tenant',input);assert.equal(report.status,'matched');assert.deepEqual(report.matches.map(a=>a.id),['3']);assert.equal(report.matches[0].date,'2026-12-01');assert.equal(report.matches[0].professional,'Ana');assert.equal(report.matches[0].created_at,Date.parse('2026-10-02T13:00:00Z'));
 assert.ok(calls.every(c=>c.tenant==='tenant'));assert.ok(!calls.some(c=>c.path==='agendamentos/999'));assert.ok(calls.every(c=>c.path==='agendamentos/list'||/^agendamentos\/\d+$/.test(c.path)));assert.equal(calls[0].body.id_filial,'9');
});
test('missing creation is inconclusive, canceled bookings are excluded and negative results are scoped to the queried range',async()=>{
 for(const created_at of [null,'2026-02-30 12:00:00','invalid']){const f=fixture([{id:1,created_at}]);assert.equal((await campaignBookings(f.api,'tenant',input)).status,'inconclusive');}
 const canceled=fixture([{id:1,created_at:'2026-10-02 10:00:00',age_status:'Cancelado'}]);assert.equal((await campaignBookings(canceled.api,'tenant',input)).status,'none_in_period');
 const empty=fixture([]);const report=await campaignBookings(empty.api,'tenant',input);assert.equal(report.status,'none_in_period');assert.equal(report.from,input.from);assert.equal(report.to,input.to);
});
test('detail mismatches and transport failures never become negative results; long scans are marked incomplete',async()=>{
 for(const mismatch of [{age_id_cliente:8},{age_id_filial:10}]){const f=fixture([{id:1,created_at:'2026-10-02 10:00:00',...mismatch}]);await assert.rejects(campaignBookings(f.api,'tenant',input),e=>e.status===502);}
 const f=fixture(Array.from({length:41},(_,i)=>({id:i+1,created_at:'2026-09-01T10:00:00-03:00'})));const r=await campaignBookings(f.api,'tenant',input);assert.equal(r.status,'inconclusive');assert.equal(r.incomplete,true);assert.equal(f.calls.length,41);
 f.api.request=async()=>{throw Object.assign(Error('Expired'),{status:409});};await assert.rejects(campaignBookings(f.api,'tenant',input),e=>e.status===409);
});
test('dates are validated and creation times without a verified timezone are inconclusive, never replaced by service dates',()=>{
 assert.equal(creationTimestamp('2026-10-01 10:00:00'),null);assert.equal(creationTimestamp('2026-10-01T10:00:00-03:00'),since);assert.equal(creationTimestamp('2026-10-01T13:00:00Z'),since);assert.equal(creationTimestamp('2026-10-01'),null);
 for(const dates of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-03',to:'2026-10-01'},{from:'2026-01-01',to:'2026-12-31'}])assert.throws(()=>consultationRange(dates));
});
