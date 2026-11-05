import test from 'node:test';
import assert from 'node:assert/strict';
import {buildMetrics,dayKey} from '../public/metrics-domain.mjs';
import {metricsMarkup,metricsCsv} from '../public/metrics.js';
import {cashbarberRecords} from '../public/booking-report.mjs';
import {summarize} from '../public/crm-domain.mjs';
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

test('booking reports sum historical reservation prices, include old leads, preserve plan zero and cross automatic/manual campaigns',()=>{
  const s=fixture(),q={clientId:'11',clientName:'=Cliente',service:'Manicure',professionalName:'Isaura',date:'2026-10-22',start:'13:00',end:'13:50',price:4500};
  s.crm.touches[0].evidence='webhook';s.crm.touches.push({id:'manual',opportunity:'o2',created:now,source:'paid',ad_id:'ad2',evidence:'manual',referral:{correct_first:true}});
  s.crm.ads.push({ad_id:'ad2',campaign_name:'Campanha manual',campaign_id:'222'});
  s.crm.bookings=[{id:'b1',conversation:'c1',actor:'a',confirmed_at:now,quote:q},{id:'b2',conversation:'c2',actor:'b',confirmed_at:now,quote:{...q,clientId:'22',price:0}},{id:'b3',conversation:'c2',actor:'b',confirmed_at:now,quote:{...q,clientId:'22',price:12000}},{id:'demo-booking',conversation:'demo',confirmed_at:now,quote:q},{id:'future',conversation:'c1',confirmed_at:now+1,quote:q},{id:'hidden',conversation:'not-visible',confirmed_at:now,quote:q}];
  s.crm.bookings.push(s.crm.bookings[0]);
  const r=buildMetrics(s,{from:'2026-10-02',to:'2026-10-02'},now);
  assert.equal(r.bookings.count,3);assert.equal(r.bookings.clients,2);assert.equal(r.bookings.value_cents,16500);assert.equal(r.bookings.groups.length,2);
  assert.equal(r.totals.booked,3);assert.equal(r.totals.booked_value,16500);
  assert.equal(r.operators.find(p=>p.id==='a').booked,1);assert.equal(r.operators.find(p=>p.id==='b').booked,2);
  assert.equal(r.channels.find(c=>c.id==='instagram').booked_value,12000);
  assert.equal(r.bookings.groups.find(g=>g.key.includes('manual')).manual,2);assert.equal(r.bookings.groups.find(g=>g.key.includes('Campanha A')).automatic,1);
  assert.equal(r.totals.revenue,5000);assert.equal(r.campaigns.length,0);
  assert.match(metricsMarkup(r),/22\/10\/2026/);assert.match(metricsCsv(r),/22\/10\/2026/);assert.ok(!metricsCsv(r).includes('2026-10-22'));
  assert.ok(metricsMarkup(r).includes('Serviços agendados no CashBarber'));assert.ok(metricsMarkup(r).includes('Valor agendado'));assert.ok(metricsCsv(r).includes("'=Cliente"));
  s.crm.catalog=[{kind:'service',name:'Manicure',price_cents:99999}];
  assert.equal(buildMetrics(s,{},now).bookings.value_cents,16500);
  const filtered=buildMetrics(s,{channel:'instagram',owner:'b',bookingQuery:'manual'},now).bookings;
  assert.equal(filtered.count,2);assert.equal(filtered.value_cents,12000);
  assert.equal(buildMetrics(s,{bookingQuery:'sem resultados'},now).bookings.count,0);
  s.crm.touches.push({id:'correct',opportunity:'o1',created:now,source:'paid',ad_id:'ad2',evidence:'manual',referral:{correct_first:true}});
  const corrected=buildMetrics(s,{},now).bookings;
  assert.equal(corrected.groups.length,1);assert.equal(corrected.groups[0].value_cents,16500);assert.equal(corrected.groups[0].manual,3);
});

test('discovered bookings enter counts, frozen values and campaign conversion by creation time without duplicating central or cross-channel reservations',()=>{
 const s=fixture(),created=stamp('2026-10-01T11:00:00');s.crm.attendance_history=[];s.crm.events=[];
 s.crm.bookings=[{id:'central',conversation:'c1',actor:'a',confirmed_at:created,quote:{clientId:'11',clientName:'Maria',service:'Manicure',serviceId:'1',price:4500},receipt:{externalId:'90'}}];
 const report={status:'matched',client_id:'11',client_name:'Maria',since:created-1000,checked_at:now,matches:[{id:'90',created_at:created,date:'2026-12-01',start:'14:00',professional:'Ana',services:['Manicure','Plano'],service_details:[{id:'1',name:'Manicure',price_cents:99999},{id:'2',name:'Plano',price_cents:0}]},{id:'91',created_at:created,services:['Massagem'],service_details:[{id:'3',name:'Massagem',price_cents:7000}]}]};
 s.crm.campaign_checks=[{conversation:'c1',actor:'b',ad_id:'ad1',checked_at:now,report},{conversation:'c2',actor:'b',ad_id:'ad2',checked_at:now,report:structuredClone(report)}];
 const r=buildMetrics(s,{from:'2026-10-01',to:'2026-10-01'},now);
 assert.equal(r.bookings.count,3);assert.equal(r.bookings.value_cents,11500);assert.equal(r.totals.booked,3);assert.equal(r.totals.booked_value,11500);assert.equal(r.bookings.clients,1);
 assert.equal(r.operators.find(p=>p.id==='a').booked,1);assert.equal(r.operators.find(p=>p.id==='cashbarber_external').booked,2);assert.ok(!r.operators.some(p=>p.id==='b'&&p.booked));
 assert.equal(buildMetrics(s,{from:'2026-10-02',to:'2026-10-02'},now).bookings.count,0);
 assert.equal(buildMetrics(s,{channel:'whatsapp'},now).bookings.count+buildMetrics(s,{channel:'instagram'},now).bookings.count,3);
 assert.equal(r.totals.sales,0);assert.equal(r.totals.revenue,0);
 const crmReport=summarize(s.crm.opportunities,[],[],'first','campaign',cashbarberRecords(s.crm,now));assert.equal(crmReport.groups.reduce((sum,g)=>sum+g.appointments,0),2);
});

test('discovered services with unknown amounts count without inventing prices; contact scheduling rate includes open leads',()=>{
 const s=fixture(),created=stamp('2026-10-01T11:00:00');s.crm.attendance_history=[];s.crm.events=[];
 s.crm.campaign_checks=[{conversation:'c1',actor:'b',ad_id:'ad1',checked_at:now,report:{status:'matched',client_id:'11',client_name:'=Cliente',checked_at:now,matches:[{id:'95',created_at:created,services:['Legado sem valor']},{id:'96',created_at:created,services:['Plano'],service_details:[{id:'7',name:'Plano',price_cents:0}]},{id:'97',created_at:now+1000,services:['Futuro']},{id:'98',created_at:created,status:'Cancelado',services:['Cancelado']}]}}];
 const r=buildMetrics(s,{from:'2026-10-01',to:'2026-10-02'},now);
 assert.equal(r.bookings.count,2);assert.equal(r.bookings.unknown_value,1);assert.equal(r.bookings.value_cents,0);assert.equal(r.bookings.rows.find(b=>b.external_id==='95').price_cents,null);assert.equal(r.bookings.rows.find(b=>b.external_id==='96').price_cents,0);
 assert.equal(r.scheduledContacts,1);assert.equal(r.contactSchedulingRate,1);assert.equal(r.campaigns[0].scheduled_leads,1);assert.equal(r.campaigns[0].appointments,1);assert.equal(r.totals.scheduled,0);assert.equal(r.schedulingRate,null);
 const markup=metricsMarkup(r),csv=metricsCsv(r);assert.match(markup,/Não informado/);assert.match(markup,/100\.0%/);assert.match(markup,/Encontrado no CashBarber/);assert.ok(!markup.includes('undefined'));assert.match(csv,/Registro encontrado por consulta/);assert.match(csv,/Legado sem valor/);assert.match(csv,/'=Cliente/);
 s.crm.campaign_checks.push({conversation:'demo',report:structuredClone(s.crm.campaign_checks[0].report)});assert.equal(buildMetrics(s,{},now).bookings.count,2);
});


test('information-only closures count as attended cases without lowering the scheduling confirmation rate',()=>{
 const state=fixture(),before=buildMetrics(state,{},now);
 state.crm.attendance_history.push({id:'info',conversation:'c1',actor:'a',action:'Atendimento finalizado',created:now,scheduling:{had_scheduling:false,outcome:'information',services:[]}});
 const after=buildMetrics(state,{},now);assert.equal(after.totals.closed,before.totals.closed+1);assert.equal(after.confirmations,before.confirmations);assert.equal(after.schedulingRate,before.schedulingRate);
});
