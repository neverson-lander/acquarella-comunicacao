import test from 'node:test';
import assert from 'node:assert/strict';
import {bookingHistoryMarkup,attendanceTimeline} from '../public/booking-history.mjs';
const esc=v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;');
test('confirmed bookings appear before closure, retain the booking actor and escaped frozen details, and remain unique',()=>{
 const b={id:'booking',actor:'reception',confirmed_at:1792608593253,quote:{service:'<Limpeza de Pele>',clientName:'Cliente',professionalName:'Profissional',date:'2026-10-22',start:'09:10',end:'10:10',price:13000},receipt:{externalId:'49229756'}};
 const team=[{id:'reception',name:'Recepcionista'}],html=bookingHistoryMarkup([b,b,{id:'pending',confirmed_at:null}],esc,team);
 assert.equal((html.match(/Agendamento confirmado no CashBarber/g)||[]).length,1);assert.ok(html.includes('&lt;Limpeza de Pele&gt;'));assert.ok(html.includes('Recepcionista'));assert.ok(html.includes('49229756'));assert.ok(html.includes('09:10'));assert.match(html,/130,00/);assert.ok(html.includes('22/10/2026'));assert.ok(!html.includes('2026-10-22'));
 const history=[{id:'claim',action:'Atendimento assumido',created:1792608500000}],timeline=attendanceTimeline(history,[b,b],team);
 assert.equal(timeline.length,2);assert.equal(timeline[0].booking.id,b.id);assert.equal(timeline[0].actor_name,'Recepcionista');assert.equal(history.length,1);assert.ok(!timeline[0].action.includes('finalizado'));
});
