import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignAnalysis,attendanceCycles,campaignAnalysisCsv} from '../public/campaign-analysis.mjs';
import {bookingReport} from '../public/booking-report.mjs';
import {buildMetrics} from '../public/metrics-domain.mjs';
const start=Date.parse('2026-08-01T10:00:00-03:00'),day=86400000,now=start+100*day;
function fixture(){
 return {opportunities:[{id:'o',conversation:'c',contact:'ct',customer:'5534999998888',customer_name:'Maria',mode:'live',channel:'whatsapp',account:'a',status:'resolved',first_contact:start}],contacts:[{id:'ct',name:'Maria',phone:'5534999998888'}],ads:[{ad_id:'ad1',campaign_id:'one',campaign_name:'Campanha 1',service:'manicure'},{ad_id:'ad2',campaign_id:'two',campaign_name:'Campanha 2'}],catalog:[{id:'manicure',name:'Manicure'}],team:[],events:[],bookings:[],attendance_history:[],campaign_checks:[],touches:[{id:'t1',opportunity:'o',created:start,source:'paid',ad_id:'ad1',evidence:'webhook'}]};
}
function closure(crm,id,time,yes,services=[]){crm.attendance_history.push({id,conversation:'c',created:time,action:'Atendimento finalizado',scheduling:{had_scheduling:yes,services}});}
function entry(crm,id,time,source='organic',ad_id=''){crm.touches.push({id,opportunity:'o',created:time,source,ad_id,evidence:'webhook',referral:{attendance_start:id}});}
function booking(crm,id,time,price=5000,other={}){crm.bookings.push({id,conversation:'c',confirmed_at:time,receipt:{externalId:id},quote:{clientId:'123',service:'Manicure',serviceId:'1',price},...other});}

test('paid booking remains attributed to its original attendance after organic and new paid returns',()=>{
 const crm=fixture();booking(crm,'b1',start+1000);closure(crm,'h1',start+2000,true,[{booking_id:'b1',name:'Manicure',price_cents:5000}]);
 entry(crm,'organic',start+day);booking(crm,'b2',start+day+1000,7000);closure(crm,'h2',start+day+2000,true);
 entry(crm,'paid2',start+2*day,'paid','ad2');booking(crm,'b3',start+2*day+1000,9000);closure(crm,'h3',start+2*day+2000,true);
 const report=campaignAnalysis(crm,{},now);assert.equal(report.direct.length,2);assert.equal(report.summary.scheduled,2);assert.equal(report.summary.services,3);assert.equal(report.summary.value_cents,21000);assert.equal(report.acquisition.length,1);
 const acquired=report.acquisition[0];assert.equal(acquired.campaign,'one');assert.equal(acquired.value_cents,21000);assert.equal(acquired.spontaneous_returns,0);assert.equal(acquired.paid_returns,1);assert.equal(acquired.first_conversion_return,false);assert.equal(acquired.repeat_conversions,1);assert.equal(acquired.windows[30].value_cents,21000);
 assert.equal(bookingReport(crm,{},now).rows.find(r=>r.external_id==='b1').campaign_name,'Campanha 1');assert.equal(bookingReport(crm,{},now).rows.find(r=>r.external_id==='b2').source,'Orgânico');
});

test('first paid contact without booking followed by spontaneous first conversion is acquired and converted on return',()=>{
 const crm=fixture();closure(crm,'h1',start+1000,false);entry(crm,'return',start+5*day);booking(crm,'b2',start+5*day+1000,0);closure(crm,'h2',start+5*day+2000,true);
 const report=campaignAnalysis(crm,{},now);assert.equal(report.summary.scheduled,0);assert.equal(report.summary.acquired,1);assert.equal(report.summary.converted,1);assert.equal(report.summary.first_conversion_return,1);assert.equal(report.acquisition[0].first_conversion_source,'organic');assert.equal(report.acquisition[0].repeat_conversions,0);assert.equal(report.acquisition[0].unknown_value,0);assert.equal(report.acquisition[0].delay_ms,5*day+1000);
 assert.equal(campaignAnalysis(crm,{from:'2026-08-02'},now).summary.acquired,0,'acquisition date is independent of later conversion date');
 assert.equal(campaignAnalysis(crm,{from:'2026-08-01',to:'2026-08-01'},now).summary.converted,1,'cohort follows later results');
});

test('a contact first recorded organic is not retroactively acquired by a later ad',()=>{
 const crm=fixture();crm.touches[0].source='organic';crm.touches[0].ad_id='';closure(crm,'h1',start+1000,false);entry(crm,'paid',start+day,'paid','ad2');booking(crm,'b',start+day+1000);closure(crm,'h2',start+day+2000,true);
 const r=campaignAnalysis(crm,{},now);assert.equal(r.summary.scheduled,1);assert.equal(r.summary.acquired,0);
});

test('same external reservation across channels and checks is counted once and identity links reunite the customer',()=>{
 const crm=fixture();crm.opportunities.push({...crm.opportunities[0],id:'o2',conversation:'c2',contact:'ct2',customer:'instagram-user',channel:'instagram',first_contact:start+day});crm.contacts.push({id:'ct2',name:'Maria Instagram',phone:'553499998888'});crm.touches.push({id:'t2',opportunity:'o2',created:start+day,source:'organic',evidence:'webhook'});
 booking(crm,'b1',start+day+1000);crm.bookings[0].quote.service='Manicure';crm.campaign_checks=[{conversation:'c2',ad_id:'ad1',checked_at:now,report:{status:'matched',since:start,client_id:'123',checked_at:now,matches:[{id:'b1',created_at:start+day+1000,services:['Manicure'],service_details:[{id:'1',name:'Manicure',price_cents:99999}]}]}}];
 const r=campaignAnalysis(crm,{},now);assert.equal(r.acquisition.length,1);assert.equal(r.acquisition[0].services.length,1);assert.equal(r.acquisition[0].value_cents,5000);
});

test('historical matched checks survive bulk cleanup, obey cycle creation boundaries and do not imply a completed service',()=>{
 const crm=fixture();crm.campaign_checks=[{conversation:'c',ad_id:'ad1',checked_at:now,report:{status:'matched',since:start,client_id:'123',checked_at:now,matches:[{id:'external',created_at:start+1000,services:['Manicure'],service_details:[{id:'1',name:'Manicure',price_cents:null}]}]}}];crm.attendance_history.push({id:'bulk',conversation:'c',created:start+2000,action:'Atendimento encerrado em massa sem início'});entry(crm,'return',start+5*day);closure(crm,'h2',start+5*day+1000,false);
 const report=campaignAnalysis(crm,{},now);assert.equal(report.summary.scheduled,1);assert.equal(report.summary.services,1);assert.equal(report.groups[0].performed,0);assert.equal(report.direct[0].unknown_value,1);assert.equal(report.direct[0].value_cents,0);
 crm.campaign_checks[0].report.matches[0].created_at=start+5*day+500;assert.equal(campaignAnalysis(crm,{},now).summary.scheduled,0,'a later return cannot be credited directly to the old attendance');
});

test('windows report maturity, ignore future/voided data and CSV escapes customer values',()=>{
 const crm=fixture();crm.contacts[0].name='=SUM(A1)';booking(crm,'early',start+day,1000);booking(crm,'future',now+1,10000);crm.events=[{opportunity:'o',kind:'sale',occurred:start+day,amount_cents:2000},{opportunity:'o',kind:'sale',occurred:start+day,amount_cents:10000,voided:1}];
 const r=campaignAnalysis(crm,{},start+45*day);assert.equal(r.acquisition[0].windows[30].mature,true);assert.equal(r.acquisition[0].windows[60].mature,false);assert.equal(r.direct[0].revenue_cents,2000);assert.equal(r.summary.services,1);assert.match(campaignAnalysisCsv(r),/'=SUM/);assert.match(campaignAnalysisCsv(r,'acquisition'),/Primeira conversão no retorno/);
 const state={crm,conversations:[]};const metrics=buildMetrics(state,{},start+45*day);assert.equal(metrics.analytics.summary.scheduled,1);
});

test('72h spontaneous continuation converts the original paid attendance without inventing another click or extending the window',()=>{
 const crm=fixture();closure(crm,'h1',start+1000,false);entry(crm,'next-day',start+day);booking(crm,'next-day-booking',start+day+1000);closure(crm,'h2',start+day+2000,true);
 entry(crm,'outside-window',start+3*day+1);booking(crm,'later-booking',start+3*day+1000,9000);closure(crm,'h3',start+3*day+2000,true);
 const r=campaignAnalysis(crm,{},now);assert.equal(r.direct.length,1);assert.equal(r.summary.scheduled,1);assert.equal(r.summary.services,1);assert.equal(r.direct[0].continuations.length,1);assert.equal(r.direct[0].value_cents,5000);assert.equal(r.acquisition[0].first_conversion_return,false);assert.equal(r.acquisition[0].spontaneous_returns,1);assert.equal(r.acquisition[0].value_cents,14000);
 assert.equal(attendanceCycles(crm,now).find(c=>c.first_contact===start+day).source,'organic','actual contact origin stays intact');
 assert.equal(r.direct[0].until,start+3*day+1);
});

test('a new ad click within 72h takes priority over the old campaign and the boundary is inclusive',()=>{
 const crm=fixture();closure(crm,'h1',start+1000,false);entry(crm,'exactly72',start+3*day);booking(crm,'same-journey',start+3*day+1);closure(crm,'h2',start+3*day+1000,true);
 let r=campaignAnalysis(crm,{},now);assert.equal(r.direct.length,1);assert.equal(r.summary.scheduled,1);
 crm.touches.find(t=>t.id==='exactly72').source='paid';crm.touches.find(t=>t.id==='exactly72').ad_id='ad2';r=campaignAnalysis(crm,{},now);assert.equal(r.direct.length,2);assert.equal(r.direct.find(c=>c.ad_id==='ad1').outcome,'not_scheduled');assert.equal(r.direct.find(c=>c.ad_id==='ad2').outcome,'scheduled');assert.equal(r.direct.find(c=>c.ad_id==='ad1').until,start+3*day);
});
