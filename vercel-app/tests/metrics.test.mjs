import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMetrics,dayKey} from '../public/metrics-domain.mjs';
import {metricsMarkup,metricsCsv} from '../public/metrics.js';
const stamp=s=>new Date(s+'-03:00').getTime(),now=stamp('2026-10-02T12:00:00');
function fixture(){
  const opportunities=[{id:'o1',conversation:'c1',contact:'ct1',mode:'live',customer:'real',first_contact:stamp('2026-10-01T09:00:00'),channel:'whatsapp',owner:'a',stage:'won'},{id:'o2',conversation:'c2',contact:'ct2',mode:'live',customer:'real2',first_contact:stamp('2026-09-01T09:00:00'),channel:'instagram',owner:'b',stage:'new'},{id:'demo',conversation:'demo',mode:'demo',customer:'demo',first_contact:now,channel:'whatsapp',stage:'new'}];
  const crm={opportunities,team:[{id:'a',name:'Ana'},{id:'b',name:'Bia'}],touches:[{id:'touch',opportunity:'o1',source:'paid',ad_id:'ad1',created:stamp('2026-10-01T09:00:00')}],ads:[{ad_id:'ad1',campaign_name:'Campanha A',campaign_id:'123'}],events:[{opportunity:'o1',kind:'sale',actor:'a',occurred:stamp('2026-10-01T11:00:00'),amount_cents:10000},{opportunity:'o1',kind:'sale',actor:'b',occurred:now,amount_cents:5000},{opportunity:'o1',kind:'sale',occurred:now,voided:now,amount_cents:90000},{opportunity:'o2',kind:'appointment',actor:'b',occurred:now},{opportunity:'o1',kind:'sale',actor:'a',occurred:now+1000,amount_cents:20000}],attendance_history:[{id:'h1',conversation:'c1',actor:'a',action:'Atendimento assumido',created:stamp('2026-10-01T09:05:00')},{id:'h2',conversation:'c1',actor:'a',action:'Atendimento finalizado',created:stamp('2026-10-01T10:00:00'),scheduling:{had_scheduling:true,services:[{id:'s1',name:'Limpeza'},{id:'s2',name:'Massagem'}]}},{id:'h3',conversation:'c1',actor:null,action:'Nova mensagem após encerramento: devolvido à fila',created:stamp('2026-10-02T09:00:00')},{id:'h4',conversation:'c1',actor:'b',action:'Atendimento assumido',created:stamp('2026-10-02T09:10:00')},{id:'h5',conversation:'c1',actor:'b',action:'Atendimento finalizado',created:stamp('2026-10-02T10:00:00'),scheduling:{had_scheduling:false,services:[]}},{id:'h6',conversation:'c2',actor:'b',action:'Atendimento finalizado',created:stamp('2026-10-01T10:00:00')},{id:'demo1',conversation:'demo',action:'Atendimento finalizado',created:now}]};
  const conversations=[{id:'c1',status:'resolved',assigned_to:'a',messages:[{direction:'in',created:stamp('2026-10-01T09:00:00')},{direction:'out',state:'sent',operator_id:'a',created:stamp('2026-10-01T09:15:00')},{direction:'out',state:'failed',operator_id:'a',created:now},{direction:'out',state:'simulated',created:now}]},{id:'c2',status:'open',assigned_to:null,messages:[{direction:'in',created:now-3600000}]},{id:'demo',status:'open',messages:[{direction:'out',state:'sent',created:now}]}];
  return {crm,conversations};
}
test('metrics separate period activity from current backlog, exclude demos, future and voided events',()=>{
  const r=buildMetrics(fixture(),{from:'2026-10-01',to:'2026-10-02'},now);
  assert.equal(r.totals.new,1);assert.equal(r.totals.open,1);assert.equal(r.totals.queue,1);assert.equal(r.totals.waiting,1);
  assert.equal(r.totals.closed,3);assert.equal(r.totals.replies,1);assert.equal(r.totals.failed,1);
  assert.equal(r.totals.sales,2);assert.equal(r.totals.revenue,15000);assert.equal(r.ticket,7500);
  assert.equal(r.totals.appointments,1);assert.equal(r.confirmations,2);assert.equal(r.schedulingRate,.5);assert.equal(r.services.length,2);
  assert.equal(r.totals.response,15*60000);assert.equal(r.totals.resolution,52.5*60000);assert.equal(r.totals.resolutionSamples,2);
  assert.equal(r.campaigns[0].leads,1);assert.equal(r.campaigns[0].sales,1);assert.equal(r.campaigns[0].conversion_rate,1);assert.equal(r.campaigns[0].revenue_cents,15000);
  assert.equal(r.campaigns[0].scheduled_leads,1);
  assert.equal(r.operators.find(p=>p.id==='a').closed,1);assert.equal(r.operators.find(p=>p.id==='b').closed,2);
});
test('channel and current-owner filters restrict all metric sources',()=>{
  const r=buildMetrics(fixture(),{channel:'whatsapp',owner:'a',from:'2026-10-02',to:'2026-10-02'},now);
  assert.equal(r.totals.closed,1);assert.equal(r.totals.new,0);assert.equal(r.totals.open,0);assert.equal(r.totals.revenue,5000);
  assert.equal(r.totals.reopened,1);assert.equal(r.totals.resolution,50*60000);assert.equal(r.campaigns.length,0);assert.equal(r.channels.length,1);
  assert.equal(r.operators.find(p=>p.id==='b').closed,1);
});
test('missing historical data remains unavailable and unknown actors do not inherit current owner credit',()=>{
  const s=fixture();s.crm.attendance_history=[];s.conversations[0].messages[1].operator_id=null;
  const r=buildMetrics(s,{},now);assert.equal(r.schedulingRate,null);assert.equal(r.totals.resolution,null);
  assert.equal(r.operators.find(p=>p.id==='unknown').replies,1);assert.equal(r.operators.find(p=>p.id==='a').response,null);
  assert.equal(dayKey(new Date('2026-10-02T01:00:00Z').getTime()),'2026-10-01');
});
test('rendering escapes customer-controlled labels and CSV neutralizes spreadsheet formulas',()=>{
  const s=fixture();s.crm.ads[0].campaign_name='<script>alert(1)</script>';s.crm.team[0].name='=HYPERLINK("evil")';
  const r=buildMetrics(s,{},now),html=metricsMarkup(r),csv=metricsCsv(r);
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(html.includes('Campanhas e aquisição'));assert.ok(html.includes('Serviços informados no encerramento'));
});
