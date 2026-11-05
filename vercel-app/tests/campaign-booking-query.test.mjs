import test from 'node:test';
import assert from 'node:assert/strict';
import {createCashbarber} from '../lib/cashbarber-store.mjs';
import {campaignAttendancesCsv} from '../public/campaign-attendances.mjs';

test('campaign queries use authenticated tenant and server attribution for open, bulk and normally closed conversations',async()=>{
 const calls=[],reference=Date.now()-86400000;let permitted=true,source='paid';
 const pool={query:async(sql,args)=>{assert.equal(args[0],'tenant');if(sql.startsWith('insert into cashbarber_campaign_check_history'))return {rows:[]};if(sql.startsWith('insert into cashbarber_campaign_checks'))return {rows:[{report:JSON.parse(args[3])}]};if(sql.includes('crm_opportunities'))return {rows:[{id:'o',mode:'live',customer:'5511999999999',first_contact:reference}]};if(sql.includes('crm_touches'))return {rows:[{source,ad_id:'123',created:reference+1000,evidence:'manual'}]};if(sql.includes('cashbarber_links'))return {rows:[{client_id:'7'}]};throw Error(sql);}};
 const client={call:async(tenant,action,input)=>{calls.push({tenant,action,input});return {status:'none_in_period',since:input.since,matches:[]};}};
 for(const status of ['open','resolved']){
  const store=createCashbarber({pool,client,getConversation:async()=>{if(!permitted)throw Object.assign(Error('Forbidden'),{status:403});return {id:'c',status};}});
  const result=await store.route({tenant:'tenant'},'/api/cashbarber/campaign-bookings',{conversation:'c',tenant:'forged',since:1,ad_id:'fake',from:'2026-10-01',to:'2026-12-01'});
  assert.equal(result.ad_id,'123');assert.equal(result.since,reference);assert.equal(calls.at(-1).tenant,'tenant');assert.equal(calls.at(-1).input.client_id,'7');
  permitted=false;await assert.rejects(store.route({tenant:'tenant'},'/api/cashbarber/campaign-bookings',{conversation:'c'}),e=>e.status===403);permitted=true;
  source='organic';await assert.rejects(store.route({tenant:'tenant'},'/api/cashbarber/campaign-bookings',{conversation:'c'}));source='paid';
 }
});
test('CSV includes independently queried creation evidence without replacing closure outcomes',()=>{
 const csv=campaignAttendancesCsv([{client:'Maria',status:'open',outcome:'pending',services:[],first_contact:1,cashbarber_check:{status:'matched',from:'2026-10-01',to:'2026-12-31',checked_at:2,matches:[{id:'90',created_at:3}]}}]);
 assert.match(csv,/Em aberto, sem confirmação/);assert.match(csv,/Reserva criada após o contato da campanha/);assert.match(csv,/"90"/);assert.match(csv,/Criação das reservas/);
});
