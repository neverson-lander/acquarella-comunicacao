import test from 'node:test';
import assert from 'node:assert/strict';
import {createServiceClock,buildMessageTimingMetrics} from '../public/message-timing-metrics.mjs';
import {messageTimingCsv} from '../public/message-timing-report.js';
const t=value=>Date.parse(value),minute=60000;
const hours={enabled:true,timezone:'America/Sao_Paulo',days:Array.from({length:7},(_,day)=>day>0&&day<6?[{start:'09:00',end:'12:00'},{start:'13:00',end:'18:00'}]:[])};
const msg=(id,sent,received,viewed,extra={})=>({id,direction:'in',created:t(sent),received_at:received?t(received):null,first_viewed_at:viewed?t(viewed):null,...extra});
const fixture=messages=>({clock_time:t('2026-11-02T12:00:00-03:00'),accounts:[{id:'a',name:'WhatsApp principal',channel:'whatsapp',mode:'live',service_hours:hours}],conversations:[{id:'c',account:'a',name:'Cliente',customer:'5534000000000',assigned_to:'ana',messages}],crm:{attendance_history:[]}});

test('business time excludes closed days, pauses and nights, and preserves zero/unknown',()=>{
 const clock=createServiceClock(hours);
 assert.equal(clock(t('2026-10-30T17:50:00-03:00'),t('2026-11-02T09:20:00-03:00')),30*minute);
 assert.equal(clock(t('2026-10-30T11:50:00-03:00'),t('2026-10-30T13:10:00-03:00')),20*minute);
 assert.equal(clock(t('2026-10-31T10:00:00-03:00'),t('2026-11-01T10:00:00-03:00')),0);
 assert.equal(clock(t('2026-10-30T09:00:00-03:00'),t('2026-10-30T09:00:00-03:00')),0);
 assert.equal(clock(null,t('2026-10-30T09:00:00-03:00')),null);
 assert.equal(clock(t('2026-10-30T10:00:00-03:00'),t('2026-10-30T09:00:00-03:00')),null);
 assert.equal(createServiceClock({...hours,enabled:false}),null);
 assert.equal(createServiceClock({...hours,timezone:'invalid'}),null);
});

test('overnight shifts and timezone daylight changes use actual elapsed business time',()=>{
 const overnight={...hours,days:Array.from({length:7},(_,day)=>day===5?[{start:'22:00',end:'02:00'}]:[])};
 assert.equal(createServiceClock(overnight)(t('2026-10-30T23:55:00-03:00'),t('2026-10-31T00:05:00-03:00')),10*minute);
 const dst={enabled:true,timezone:'America/New_York',days:Array.from({length:7},(_,day)=>day===0?[{start:'00:00',end:'04:00'}]:[])};
 assert.equal(createServiceClock(dst)(t('2026-11-01T00:00:00-04:00'),t('2026-11-01T04:00:00-05:00')),5*3600000);
 assert.equal(createServiceClock(dst)(t('2026-03-08T00:00:00-05:00'),t('2026-03-08T04:00:00-04:00')),3*3600000);
});

test('means, independent delay filters, business-hour validation and pending waits use recorded first views',()=>{
 const state=fixture([
  msg('weekend','2026-10-30T17:49:00-03:00','2026-10-30T17:50:00-03:00','2026-11-02T09:20:00-03:00'),
  msg('outside','2026-10-30T17:49:30-03:00','2026-10-30T17:50:00-03:00','2026-10-30T19:00:00-03:00'),
  msg('pending','2026-11-02T09:59:50-03:00','2026-11-02T10:00:00-03:00',null),
  msg('legacy','2026-10-30T10:00:00-03:00',null,null),
 ]);
 let result=buildMessageTimingMetrics(state);
 assert.equal(result.delivery.samples,3);assert.equal(result.delivery.mean,(60000+30000+10000)/3);
 assert.equal(result.opening.samples,2);assert.equal(result.opening.mean,20*minute);
 assert.equal(result.pending,2);assert.equal(result.outside,1);assert.equal(result.rows.find(r=>r.id==='pending').pending,120*minute);
 assert.deepEqual(buildMessageTimingMetrics(state,{delay:'delivery',deliverySeconds:30}).rows.map(r=>r.id),['weekend']);
 assert.deepEqual(new Set(buildMessageTimingMetrics(state,{delay:'opening',openingMinutes:20}).rows.map(r=>r.id)),new Set(['weekend','pending']));
 assert.deepEqual(buildMessageTimingMetrics(state,{delay:'both',deliverySeconds:30,openingMinutes:20}).rows.map(r=>r.id),['weekend']);
 assert.equal(buildMessageTimingMetrics(state,{delay:'either',deliverySeconds:30,openingMinutes:20}).rows.length,2);
 assert.equal(buildMessageTimingMetrics(state,{opening:'outside'}).rows[0].id,'outside');
 assert.equal(buildMessageTimingMetrics(state,{opening:'inside'}).opening.mean,30*minute);
 assert.equal(buildMessageTimingMetrics(state,{opening:'pending'}).opening.samples,0);
 const noGrade=structuredClone(state);noGrade.accounts[0].service_hours.enabled=false;
 result=buildMessageTimingMetrics(noGrade);assert.equal(result.opening.mean,null);assert.equal(result.unconfigured,4);assert.equal(result.elapsed.samples,2);
 assert.equal(buildMessageTimingMetrics(noGrade,{delay:'opening',openingMinutes:0}).rows.length,0);
});

test('period is based on send date in Brasília and scopes exclude demo, social, bulk and unrelated owners/channels',()=>{
 const state=fixture([msg('included','2026-10-30T23:59:58-03:00','2026-10-31T00:00:05-03:00',null)]);
 assert.equal(buildMessageTimingMetrics(state,{from:'2026-10-30',to:'2026-10-30'}).rows.length,1);
 assert.equal(buildMessageTimingMetrics(state,{from:'2026-10-31'}).rows.length,0);
 for(const filters of [{owner:'bia'},{channel:'instagram'}])assert.equal(buildMessageTimingMetrics(state,filters).rows.length,0);
 for(const mutate of [s=>s.accounts[0].mode='demo',s=>s.conversations[0].attendance_eligible=false,s=>s.conversations[0].messages[0].direction='out',s=>s.conversations[0].messages[0].attendance_relevant=false,s=>s.crm.attendance_history.push({conversation:'c',action:'Atendimento encerrado em massa'})]){
  const copy=structuredClone(state);mutate(copy);assert.equal(buildMessageTimingMetrics(copy).rows.length,0);
 }
});

test('missing and reversed timestamps do not create false averages, and CSV exports full filtered detail safely',()=>{
 const state=fixture([
  msg('invalid','2026-10-30T10:00:30-03:00','2026-10-30T10:00:00-03:00','2026-10-30T09:59:59-03:00'),
  msg('zero','2026-10-30T10:00:00-03:00','2026-10-30T10:00:00-03:00','2026-10-30T10:00:00-03:00'),
 ]);state.conversations[0].name='=HYPERLINK("bad")';
 const result=buildMessageTimingMetrics(state);assert.equal(result.invalid,1);assert.equal(result.delivery.mean,0);assert.equal(result.delivery.samples,1);assert.equal(result.opening.mean,0);assert.equal(result.opening.samples,1);
 const csv=messageTimingCsv(result,{});assert.match(csv,/Primeira abertura/);assert.match(csv,/'=HYPERLINK/);assert.ok(csv.includes('invalid'));assert.ok(csv.includes('zero'));
});
