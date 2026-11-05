import test from 'node:test';
import assert from 'node:assert/strict';
import {metricsCrm} from '../public/metrics-scope.mjs';
import {buildMetrics} from '../public/metrics-domain.mjs';
import {metricsCsv} from '../public/metrics.js';
import {bookingReport,cashbarberRecords} from '../public/booking-report.mjs';
import {campaignAttendances} from '../public/campaign-attendances.mjs';
import {summarize} from '../public/crm-domain.mjs';
import {evaluationMetrics} from '../public/evaluations.js';

const now=Date.parse('2026-10-28T12:00:00-03:00');
function fixture(){
 const ids=['regular','bulk','interaction'];
 return {
  accounts:[{id:'a',channel:'whatsapp',mode:'live'}],
  conversations:ids.map(id=>({id,account:'a',status:'open',assigned_to:'u',messages:[{direction:'in',created:now-60000},{direction:'out',state:'sent',operator_id:'u',created:now-30000},{direction:'out',state:'failed',created:now}],evaluations:[{id:'evaluation-'+id,created:now,state:'completed',score:8,owner:'u',owner_name:'Ana',rubric:'v1',result:{summary:id}}]})),
  crm:{team:[{id:'u',name:'Ana'}],ads:[{ad_id:'ad',campaign_id:'campaign'}],contacts:[],catalog:[],
   opportunities:ids.map(id=>({id,conversation:id,mode:'live',customer:id,channel:'whatsapp',account:'a',owner:'u',first_contact:now-60000,status:'open',stage:'won'})),
   touches:ids.map(id=>({id,opportunity:id,created:now-60000,source:'paid',ad_id:'ad'})),
   events:ids.flatMap(id=>['appointment','attendance','sale'].map(kind=>({opportunity:id,actor:'u',kind,occurred:now,amount_cents:10000}))),
   bookings:ids.map(id=>({id,conversation:id,actor:'u',confirmed_at:now,quote:{clientId:id,service:'Serviço '+id,price:5000}})),
   campaign_checks:ids.map(id=>({conversation:id,report:{status:'matched',checked_at:now,client_id:id,matches:[{id:'external-'+id,created_at:now,service_details:[{name:'Consulta '+id,price_cents:2000}]}]}})),
   attendance_history:[...ids.map(id=>({id,conversation:id,action:'Atendimento finalizado',actor:'u',created:now,scheduling:{had_scheduling:true,services:[{id,name:id}]}})),
    {id:'old-bulk',conversation:'bulk',action:'Atendimento encerrado em massa sem início',created:now-90*86400000},
    {id:'old-interaction',conversation:'interaction',action:'Interação do Instagram encerrada em massa',created:now-90*86400000}]
  }
 };
}

test('operational metrics exclude bulk closures while campaign history preserves their valid conversions',()=>{
 const state=fixture(),original=structuredClone(state),clean=structuredClone(state);
 clean.crm.opportunities=clean.crm.opportunities.filter(o=>o.conversation==='regular');
 clean.crm.attendance_history=clean.crm.attendance_history.filter(h=>h.conversation==='regular');
 clean.conversations=clean.conversations.filter(c=>c.id==='regular');
 for(const filters of [{},{from:'2026-10-28',to:'2026-10-28'},{owner:'u',channel:'whatsapp'}]){
  const actual=buildMetrics(state,filters,now),expected=buildMetrics(clean,filters,now);
  assert.equal(actual.analytics.summary.scheduled,3,'historical paid conversions survive bulk cleanup');
  const {analytics:actualCampaigns,...actualOperation}=actual,{analytics:expectedCampaigns,...expectedOperation}=expected;
  assert.deepEqual(actualOperation,expectedOperation);
  assert.equal(metricsCsv({...actual,analytics:expectedCampaigns}),metricsCsv(expected));
  assert.equal(actual.totals.new,1);assert.equal(actual.totals.revenue,10000);assert.equal(actual.totals.booked,2);
 }
 assert.deepEqual(bookingReport(state.crm,{},now),bookingReport(clean.crm,{},now));
 assert.deepEqual(cashbarberRecords(state.crm,now),cashbarberRecords(clean.crm,now));
 const scoped=metricsCrm(state.crm,state.conversations);
 assert.deepEqual(campaignAttendances(scoped,{},now),campaignAttendances(clean.crm,{},now));
 assert.deepEqual(summarize(scoped.opportunities,scoped.events,state.conversations.flatMap(c=>c.messages)),summarize(clean.crm.opportunities,clean.crm.events,clean.conversations.flatMap(c=>c.messages)));
 assert.equal(evaluationMetrics(state,{},String),evaluationMetrics(clean,{},String));
 assert.deepEqual(state,original,'reporting must preserve conversations and history');
});

test('legacy bulk action and conversation-local history exclude records without matching reasons or timestamps',()=>{
 const state=fixture();state.crm.attendance_history=[];
 state.conversations[1].attendance_history=[{action:'Atendimento encerrado em massa'}];
 state.conversations[2].attendance_history=[{action:'Atendimento finalizado',reason:'encerrado em massa'}];
 assert.deepEqual(metricsCrm(state.crm,state.conversations).opportunities.map(o=>o.id),['regular','interaction']);
 assert.equal(buildMetrics(state,{},now).totals.new,2);
 assert.ok(!evaluationMetrics(state,{},String).includes('data-open-evaluation="evaluation-bulk"'));
});
