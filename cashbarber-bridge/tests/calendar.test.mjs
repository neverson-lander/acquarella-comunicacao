import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {CashBrowser} from '../browser.mjs';
import {freeRanges,parseCalendar,calendarDate} from '../calendar.mjs';
const date='2026-10-20',now=Date.parse('2026-10-19T12:00:00-03:00');
test('weekly availability merges busy, breaks and non-working periods and excludes past times',()=>{
 const result=freeRanges({date,start:'08:00',end:'21:00',now,blocks:[{start:'08:00',end:'13:00'},{start:'14:00',end:'14:50'},{start:'14:40',end:'15:30'},{start:'18:00',end:'21:00'}]});
 assert.deepEqual(result,[{start:'13:00',end:'14:00'},{start:'15:30',end:'18:00'}]);
 assert.deepEqual(freeRanges({date:'2026-10-18',start:'08:00',end:'21:00',blocks:[],now}),[]);
 assert.deepEqual(freeRanges({date:'2026-10-19',start:'08:00',end:'13:00',blocks:[],now}),[{start:'12:05',end:'13:00'}]);
 assert.throws(()=>calendarDate('2026-02-30'));assert.throws(()=>calendarDate('2030-01-01'));
});
test('missing and malformed professional columns never become free slots',()=>{
 const data={headers:['Isaura','Bia'],times:['08:00','08:10','20:50'],columns:[[{start:'08:00',end:'13:00',kind:'off'}],[{start:'',end:'',kind:'busy'}]]};
 const result=parseCalendar(data,date,[{id:'1',name:'Isaura'},{id:'2',name:'Bia'},{id:'3',name:'Não exibida'}],now);
 assert.equal(result.end,'21:00');assert.equal(result.professionals[0].windows[0].start,'13:00');assert.equal(result.professionals[1].windows.length,0);assert.ok(result.professionals[1].error);assert.ok(result.professionals[2].error);
 assert.throws(()=>parseCalendar({...data,headers:['Isaura']},date,[],now));
});
test('live calendar adapter accepts checkbox counter and extracts time-only blocks from every professional',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage();await page.setContent(`<input type="date" value="2026-10-19"><label><input type="checkbox">16 AGENDAMENTOS</label><button>Todos</button><div class="rbc-time-view"><div class="rbc-time-header-content"><div role="group" aria-label="Isaura: 1 agendamento"></div></div><div class="rbc-time-gutter"><span class="rbc-label">08:00</span><span class="rbc-label">08:10</span><span class="rbc-label">20:50</span></div><div class="rbc-time-content"><div class="rbc-day-slot"><div class="rbc-event">Cliente privado 13:00 - 13:50</div><div class="rbc-event">Não atende 08:00 - 13:00</div></div></div></div>`);
  const cash=new CashBrowser(browser,null);cash.goto=async()=>{};const data=await cash.calendar(page,date);
  assert.equal(await page.locator('input[type=date]').inputValue(),date);assert.equal(data.columns[0][0].kind,'busy');assert.equal(data.columns[0][1].kind,'off');assert.ok(!JSON.stringify(data).includes('Cliente privado'));
  const result=parseCalendar(data,date,[{id:'1',name:'Isaura'}],now);assert.equal(result.professionals[0].windows[0].start,'13:50');
 }finally{await browser.close();}
});
test('read cache is tenant-scoped, copied, bounded, bypassable and invalidated by writes',async()=>{
 const cash=new CashBrowser(null,null);cash.page=async()=>({});let reads=0;
 cash.professionals=async()=>{reads++;return [{id:'1',name:'Isaura'}];};
 const first=await cash.perform('tenant-a','professionals',{});first.professionals[0].name='Mutated';
 assert.equal((await cash.perform('tenant-a','professionals',{})).professionals[0].name,'Isaura');assert.equal(reads,1);
 await cash.perform('tenant-b','professionals',{});assert.equal(reads,2);
 await cash.perform('tenant-a','professionals',{refresh:true});assert.equal(reads,3);
 cash.commit=async()=>({state:'uncertain'});await cash.perform('tenant-a','commit',{});await cash.perform('tenant-a','professionals',{});assert.equal(reads,4);
 await cash.perform('tenant-b','professionals',{});assert.equal(reads,4);
 for(let i=0;i<220;i++)cash.remember('x','key'+i,{},1000);assert.ok(cash.cache.size<=200);
});
test('browser lock stays held until an asynchronous read completes',async()=>{
 const cash=new CashBrowser(null,null);cash.page=async()=>({});let done;cash.professionals=()=>new Promise(resolve=>{done=resolve;});
 const result=cash.perform('a','professionals',{});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(cash.locks.has('a'),true);await assert.rejects(cash.perform('a','client',{id:'1'}),e=>e.status===409);
 done([]);await result;assert.equal(cash.locks.has('a'),false);
});

test('unexpected browser failures discard the broken page without replaying the failed operation',async()=>{
 const cash=new CashBrowser(null,null);let closed=0,attempts=0;cash.contexts.set('a',{close:async()=>{closed++;}});cash.page=async()=>({});cash.professionals=async()=>{attempts++;throw Error('Page crashed');};
 await assert.rejects(cash.perform('a','professionals',{}),/Page crashed/);assert.equal(attempts,1);assert.equal(closed,1);assert.equal(cash.contexts.has('a'),false);assert.equal(cash.locks.has('a'),false);
});

test('browsing reuses recent metadata but every quote still reads agenda and provider price; commit re-reads metadata',async()=>{
 const cash=new CashBrowser(null,null),client={id:'1',name:'Cliente'},professional={id:'2',name:'Isaura',services:[{name:'Manicure',price:99999}],work:[{day:'Terça',start:'13:00',end:'18:00'}],breaks:[]};let reads=0,agendas=0,prices=0;
 cash.client=async()=>{reads++;return client;};cash.professional=async()=>{reads++;return professional;};cash.agenda=async()=>{agendas++;return [];};
 cash.form=async()=>{prices++;return {quote:{duration:50,price:4500},form:{getByRole:()=>({click:async()=>{}})}};};
 const details={clientId:'1',professionalId:'2',service:'Manicure',date:'2099-10-20',start:'13:00'};
 assert.equal((await cash.preview(null,details,false,{client,professional})).quote.price,4500);assert.equal(reads,0);assert.equal(agendas,1);assert.equal(prices,1);
 await cash.preview(null,details,true,{client,professional});assert.equal(reads,2);assert.equal(agendas,2);assert.equal(prices,2);
});
