import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalScheduling} from '../lib/external-scheduling.mjs';

test('existing appointments are re-read by tenant, client and date; forged details and missing reservations cannot close',async()=>{
 const calls=[],appointment={id:'90',client_id:'7',client_name:'Maria',professional_id:'2',professional:'Ana',date:'2026-10-22',start:'14:00',services:[{id:'3',name:'Manicure'},{id:'4',name:'Pedicure'}]};
 const resolve=createExternalScheduling({client:{call:async(tenant,action,input)=>{calls.push({tenant,action,input});return {appointments:[appointment]};}}});
 const input={client_id:'7',date:'2026-10-22',appointment_ids:['90'],client_name:'Forged',services:[{name:'Forged'}]};
 const result=await resolve({tenant:'company'},input);
 assert.deepEqual(calls,[{tenant:'company',action:'appointments',input:{client_id:'7',date:'2026-10-22'}}]);
 assert.equal(result.client_name,'Maria');assert.deepEqual(result.services.map(s=>s.name),['Manicure','Pedicure']);assert.ok(result.services.every(s=>s.external_appointment_id==='90'&&s.start==='14:00'&&s.source==='cashbarber_external'));
 for(const overrides of [{appointment_ids:[]},{appointment_ids:['90','90']},{appointment_ids:['91']},{client_id:'8'},{appointment_ids:['invalid']}])await assert.rejects(resolve({tenant:'company'},{...input,...overrides}));
});

test('reported bookings validate CashBarber professional/service pairs and client in the authenticated company',async()=>{
 const calls=[],client={call:async(tenant,action,input)=>{calls.push({tenant,action,input});if(action==='professionals')return {professionals:[{id:'1',name:'Isaura'},{id:'2',name:'Ana'}]};if(action==='services')return {services:[{id:'3',name:'Manicure',price:4500}]};if(action==='client')return {client:{id:input.id,name:'Maria'}};if(action==='clients')return {clients:[]};throw Error(action);}},resolve=createExternalScheduling({client}),user={tenant:'company'};
 for(const input of [null,{}, {client_id:'7',services:[]},{client_id:'7',services:[{professional_id:'x',service_id:'3'}]},{client_id:'7',services:[{professional_id:'9',service_id:'3'}]},{client_id:'7',services:[{professional_id:'1',service_id:'8'}]},{services:[{professional_id:'1',service_id:'3'}]},{client_not_found:true,client_search:'',services:[{professional_id:'1',service_id:'3'}]},{client_not_found:true,client_id:'7',services:[{professional_id:'1',service_id:'3'}]}])await assert.rejects(resolve(user,input),e=>e.status===400);
 const input={tenant:'forged',client_id:'7',client_name:'Forged',services:[{professional_id:'1',service_id:'3',name:'Forged',professional:'Forged',price_cents:1},{professional_id:'2',service_id:'3'}]},result=await resolve(user,input);
 assert.equal(result.client_id,'7');assert.equal(result.client_name,'Maria');assert.equal(result.client_not_found,false);assert.deepEqual(result.services.map(s=>s.professional),['Isaura','Ana']);assert.ok(result.services.every(s=>s.name==='Manicure'&&s.source==='cashbarber_external'&&!('booking_id' in s)&&!('price_cents' in s)));assert.ok(calls.every(c=>c.tenant==='company'));assert.ok(!calls.some(c=>['preview','commit'].includes(c.action)));
 const missing=await resolve(user,{client_not_found:true,client_search:'Não encontrado',services:[{professional_id:'1',service_id:'3'}]});assert.equal(missing.client_id,null);assert.equal(missing.client_not_found,true);assert.ok(calls.some(c=>c.action==='clients'&&c.input.search==='Não encontrado'));
 await assert.rejects(resolve(user,{client_id:'7',services:[{professional_id:'1',service_id:'3'},{professional_id:'1',service_id:'3'}]}),e=>e.status===400);
 const offline=createExternalScheduling({client:{call:async()=>{throw Object.assign(Error('Reconecte CashBarber'),{status:503});}}});await assert.rejects(offline(user,input),e=>e.status===503);
});


test('closure revalidates selected appointments across dates and keeps retroactive day lookup',async()=>{
 const calls=[],appointments=[{id:'90',client_id:'7',client_name:'Maria',professional_id:'2',professional:'Ana',date:'2026-11-05',start:'14:00',services:[{id:'3',name:'Manicure'}]},{id:'91',client_id:'7',client_name:'Maria',professional_id:'4',professional:'Isaura',date:'2026-12-02',start:'09:00',services:[{id:'5',name:'Pedicure'}]}];
 const resolve=createExternalScheduling({client:{call:async(tenant,action,input)=>{calls.push({tenant,action,input});return {appointments};}}});
 const input={client_id:'7',from:'2026-10-27',to:'2027-10-27',appointment_ids:['90','91']};
 const result=await resolve({tenant:'company'},input);
 assert.deepEqual(calls[0],{tenant:'company',action:'appointments',input:{client_id:'7',from:'2026-10-27',to:'2027-10-27'}});
 assert.deepEqual(result.services.map(s=>[s.external_appointment_id,s.date,s.professional]),[['90','2026-11-05','Ana'],['91','2026-12-02','Isaura']]);
 appointments.pop();await assert.rejects(resolve({tenant:'company'},input),e=>e.status===409);
 await assert.rejects(resolve({tenant:'company'},{...input,to:'2028-10-27'}),e=>e.status===400);
});
