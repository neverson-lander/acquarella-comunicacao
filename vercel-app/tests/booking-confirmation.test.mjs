import test from 'node:test';import assert from 'node:assert/strict';
import {bookingConfirmationText,mergeBookingConfirmation} from '../public/booking-confirmation.mjs';
const booking=(id,quote={},extra={})=>({id,state:'confirmed',quote:{clientId:'1',clientName:'Mariana Oliveira',professionalName:'Beatriz',service:'Manicure Tradicional',serviceId:'7',date:'2026-10-25',start:'14:00',...quote},receipt:{externalId:id},...extra});
test('confirmation follows the approved message and fills customer, service, date and time without naming the professional',()=>{
 const one=booking('10');assert.equal(bookingConfirmationText([one],'1'),`Olá, Mariana Oliveira! ✨

É um prazer confirmar seu horário no Espaço Acquarella.

📋 Serviço: Manicure Tradicional

📅 Data: 25/10/2026

🕒 Horário: 14:00

Caso precise ajustar seu horário ou tenha qualquer dúvida, estamos à disposição por aqui.

Será um prazer te receber!!

Até breve!
Equipe Espaço Acquarella`);
 const several=booking('11',{date:'2026-10-24',start:'16:30',professionalName:'  Isaura\nSilva ',services:[{id:'8',name:'  Depilação\nAxila '},{id:'9',name:'Design de Sobrancelhas'}]});
 const text=bookingConfirmationText([one,several,one],'1');
 const blocks=text.split(/\*Agendamento \d+\*\n\n/).slice(1);assert.equal(blocks.length,3);
 assert.ok(blocks[0].startsWith('📋 Serviço: Depilação Axila\n\n📅 Data: 24/10/2026\n\n🕒 Horário: 16:30'));
 assert.ok(blocks[1].startsWith('📋 Serviço: Design de Sobrancelhas\n\n📅 Data: 24/10/2026\n\n🕒 Horário: 16:30'));
 assert.ok(blocks[2].startsWith('📋 Serviço: Manicure Tradicional\n\n📅 Data: 25/10/2026\n\n🕒 Horário: 14:00'));
 assert.ok(bookingConfirmationText([one],'1','  Maria\nSouza ').startsWith('Olá, Maria Souza! ✨'));
 const withoutNames=bookingConfirmationText([booking('missing',{clientName:'',professionalName:''})],'1');assert.ok(withoutNames.startsWith('Olá! ✨'));assert.ok(!withoutNames.includes('Profissional:'));assert.ok(!text.includes('Profissional:'));assert.ok(!text.includes('Beatriz'));assert.ok(!text.includes('Isaura'));
});
test('unconfirmed, cancelled, replaced, closed and other-client bookings never enter the confirmation',()=>{
 const excluded=['preview','pending','uncertain','rejected','cancelled','rescheduled'].map((state,i)=>booking(String(i),{},{state}));
 excluded.push(booking('closed',{},{closure_id:'closure'}),booking('other',{clientId:'2'}),booking('bad-date',{date:'2026-02-30'}),booking('bad-time',{start:'25:00'}));
 assert.equal(bookingConfirmationText(excluded,'1'),'');assert.equal(bookingConfirmationText([booking('1')],null),'');
 assert.ok(!bookingConfirmationText([booking('active'),...excluded],'1').includes('undefined'));
});
test('preparing a response preserves existing drafts, avoids duplicate text, and updates earlier generated confirmations',()=>{
 const first=bookingConfirmationText([booking('1')],'1'),next=bookingConfirmationText([booking('1'),booking('2',{service:'Pedicure',serviceId:'8',start:'15:00'})],'1');
 assert.equal(mergeBookingConfirmation('',first),first);const draft=mergeBookingConfirmation('Olá! Segue a confirmação.',first);
 assert.equal(mergeBookingConfirmation(draft,first,first),draft);
 assert.equal(mergeBookingConfirmation(draft,next,first),'Olá! Segue a confirmação.\n\n'+next);
 assert.equal(mergeBookingConfirmation('Texto editado pelo atendente',next,first),'Texto editado pelo atendente\n\n'+next);
});
