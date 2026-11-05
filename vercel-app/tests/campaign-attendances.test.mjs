import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignAttendances,campaignAttendancesCsv} from '../public/campaign-attendances.mjs';
const now=1792600000000;
function fixture(){
 const crm={opportunities:[],contacts:[],touches:[],ads:[{ad_id:'123',ad_name:'Anúncio mãos',campaign_id:'456',campaign_name:'Semana das unhas'}],team:[{id:'u',name:'Ana'}],catalog:[],attendance_history:[],bookings:[]};
 for(const [id,status]of [['yes','resolved'],['no','resolved'],['open','open'],['legacy','resolved'],['reopen','open'],['booking','open'],['organic','resolved']]){crm.opportunities.push({id,conversation:id,contact:id,customer:'55'+id,customer_name:id,channel:'whatsapp',mode:'live',account:'a',owner:'u',status,first_contact:now-10000});crm.contacts.push({id,name:id,phone:'55'+id});crm.touches.push({id,opportunity:id,source:id==='organic'?'organic':'paid',ad_id:id==='organic'?'':'123',evidence:'webhook',created:now-10000});}
 crm.attendance_history=[{id:'hyes',conversation:'yes',action:'Atendimento finalizado',created:now-5000,scheduling:{had_scheduling:true,services:[{id:'s',name:'Manicure'}]}},{id:'hno',conversation:'no',action:'Atendimento finalizado',created:now-5000,scheduling:{had_scheduling:false,services:[]}},{id:'hreopen',conversation:'reopen',action:'Atendimento finalizado',created:now-5000,scheduling:{had_scheduling:false,services:[]}}];
 crm.bookings=[{id:'b',conversation:'booking',closure_id:null,quote:{service:'Pedicure',price:4500}},{id:'past',conversation:'reopen',closure_id:'old',quote:{service:'Serviço anterior'}}];return crm;
}
test('campaign attendance includes non-bookers, manual services and active reservations without inventing outcomes for open or legacy cases',()=>{
 const crm=fixture(),r=campaignAttendances(crm,{},now);assert.equal(r.rows.length,6);assert.deepEqual(r.counts,{scheduled:2,not_scheduled:1,information:0,pending:2,unknown:1});
 assert.equal(r.rows.find(r=>r.id==='yes').services[0].name,'Manicure');assert.equal(r.rows.find(r=>r.id==='booking').services[0].name,'Pedicure');assert.equal(r.rows.find(r=>r.id==='reopen').outcome,'pending');
 assert.equal(campaignAttendances(crm,{outcome:'not_scheduled'},now).rows[0].client,'no');assert.equal(campaignAttendances(crm,{query:'Pedicure'},now).rows.length,1);assert.equal(campaignAttendances(crm,{campaign:'456',channel:'a',owner:'u'},now).rows.length,6);assert.equal(campaignAttendances(crm,{ad:'unknown'},now).rows.length,0);
 crm.touches.push({id:'correction',opportunity:'yes',source:'organic',evidence:'manual',referral:{correct_first:true},created:now-1});assert.ok(!campaignAttendances(crm,{},now).rows.some(r=>r.id==='yes'));
});
test('campaign reports preserve frozen attribution, omit demos, filter dates and escape spreadsheet formulas',()=>{
 const crm=fixture();crm.opportunities[0].customer='demo-yes';crm.touches[1].meta_snapshot={campaign_id:'old',campaign_name:'Campanha preservada'};crm.contacts[1].name='=SUM(A1)';
 const rows=campaignAttendances(crm,{campaign:'old'},now).rows;assert.equal(rows.length,1);assert.equal(rows[0].campaign_name,'Campanha preservada');assert.ok(campaignAttendancesCsv(rows).includes("'=SUM(A1)"));assert.equal(campaignAttendances(crm,{from:'2027-01-01'},now).rows.length,0);
});


test('information-only closures remain distinct from unsuccessful scheduling in reports and CSV',()=>{
 const crm=fixture();crm.attendance_history.find(h=>h.conversation==='no').scheduling.outcome='information';
 const result=campaignAttendances(crm,{outcome:'information'},now);
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].id,'no');assert.equal(result.counts.information,1);
 assert.equal(campaignAttendances(crm,{outcome:'not_scheduled'},now).rows.length,0);
 assert.match(campaignAttendancesCsv(result.rows),/Dúvidas \/ Informações/);
});
