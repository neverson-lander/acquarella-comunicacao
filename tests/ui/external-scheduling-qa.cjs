const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const now=Date.now(),root=path.resolve('vercel-app/public'),calls=[];
const quote={clientId:'123',clientName:'Cliente de teste',professionalName:'Isaura',service:'Manicure Tradicional',price:4500,duration:50,date:'2026-10-22',start:'13:00',end:'13:50'};
const centralBookings=[{id:'11111111-1111-4111-8111-111111111111',conversation:'c',actor:'u',quote,receipt:{externalId:'987'},confirmed_at:now-60000},{id:'22222222-2222-4222-8222-222222222222',conversation:'c',actor:'u',quote:{...quote,service:'Pedicure no plano',price:0,start:'14:00',end:'14:50'},receipt:{externalId:'988'},confirmed_at:now-30000}];
const bookings=[];let mode='missing',failDirectory=true,saves=0;
const state={user:{id:'u',name:'Ana',role:'admin'},tenant:{id:'t',name:'Teste',phone:'5534999999999'},accounts:[{id:'a',name:'WhatsApp',channel:'whatsapp',mode:'live',enabled:true}],conversations:[{id:'c',name:quote.clientName,customer:'553484411948',account:'a',status:'open',assigned_to:'u',assignee_name:'Ana',updated:now,last_inbound:now,messages:[],attendance_history:[]}],users:[],jobs:[],audit:[]};
const crm={team:[{id:'u',name:'Ana',role:'admin',accounts:['a']}],opportunities:[{id:'o',conversation:'c',contact:'ct',customer:'553484411948',customer_name:quote.clientName,channel:'whatsapp',mode:'live',owner:'u',first_contact:now-90*86400000,stage:'new'}],contacts:[],catalog:[],tags:[],touches:[{id:'touch',opportunity:'o',source:'organic',ad_id:'',evidence:'webhook',created:now-90*86400000}],events:[],ads:[{ad_id:'123456',ad_name:'Anúncio de teste',campaign_id:'camp',campaign_name:'Campanha de teste'}],history:[],attendance_history:[],bookings};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};calls.push({path:url.pathname,input});let result={};
  if(url.pathname==='/api/bootstrap')result={setup:false};
  if(url.pathname==='/api/state')result={...state,server_time:Date.now()};
  if(url.pathname==='/api/crm/state')result=crm;
  if(url.pathname==='/api/cashbarber/closure')result={bookings,link:null};
  if(url.pathname==='/api/cashbarber/professionals'){if(failDirectory){failDirectory=false;res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'Consulta temporariamente indisponível'}));return;}result={professionals:[{id:'1',name:'Isaura'},{id:'2',name:'Ana'}]};}
  if(url.pathname==='/api/cashbarber/services')result={services:[{id:input.id==='1'?'7':'8',name:input.id==='1'?'Manicure':'Massagem'}]};
  if(url.pathname==='/api/cashbarber/clients')result={clients:mode==='found'?[{id:'9',name:'Maria'}]:[]};
  if(url.pathname==='/api/cashbarber/client')result={client:{id:'9',name:'Maria'}};
  if(url.pathname==='/api/conversations/c/status'){
   saves++;assert.equal(input.had_scheduling,true);assert.deepEqual(input.cash_booking_ids,[]);assert.deepEqual(input.scheduled_services,[]);assert.equal(input.source,'organic');assert.ok(input.external_scheduling.services.some(s=>s.professional_id==='1'&&s.service_id==='7'));
   if(mode==='missing'){assert.equal(input.external_scheduling.client_id,null);assert.equal(input.external_scheduling.client_not_found,true);assert.ok(input.external_scheduling.client_search.length>=3);assert.equal(input.external_scheduling.services.length,2);}else{assert.equal(input.external_scheduling.client_id,'9');assert.equal(input.external_scheduling.client_not_found,false);}
   state.conversations[0].status='resolved';state.conversations[0].attendance_history=[{id:'history',created:Date.now(),actor_name:'Ana',action:'Atendimento finalizado',scheduling:{had_scheduling:true,external_client:{id:input.external_scheduling.client_id,name:mode==='found'?'Maria':'',not_found:mode==='missing'},services:input.external_scheduling.services.map(s=>({name:s.service_id==='7'?'Manicure':'Massagem',professional:s.professional_id==='1'?'Isaura':'Ana',source:'cashbarber_external'}))}}];result={ok:true};
  }
  res.setHeader('content-type','application/json');return res.end(JSON.stringify(result));
 }
 const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
 res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 for(const scenario of ['missing','found']){mode=scenario;state.conversations[0].status='open';state.conversations[0].attendance_history=[];await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-attendance-scope=mine]').click();await page.locator('#resolve').click();const modal=page.locator('#modal'),submit=modal.getByRole('button',{name:'Encerrar atendimento',exact:true});assert.equal(await modal.locator('[data-external-scheduling]').isHidden(),true);await modal.locator('[name=had_scheduling]').selectOption('yes');await modal.locator('[data-external-mode]').selectOption('manual');assert.equal(await modal.locator('[data-external-search]').inputValue(),'(34) 98441-1948');assert.equal(await modal.locator('[data-external-missing-label]').isHidden(),true);
  if(scenario==='missing'){await modal.locator('[data-external-status]').filter({hasText:'temporariamente indisponível'}).waitFor();await modal.locator('[data-external-retry]').click();}
  await modal.locator('[data-external-professional] option[value="1"]').first().waitFor({state:'attached'});await modal.locator('[data-external-professional]').first().selectOption('1');await modal.locator('[data-external-service][value="7"]').first().waitFor({state:'attached'});await modal.locator('[data-external-service][value="7"]').first().check();
  const before=saves;await submit.click();await page.waitForFunction(()=>document.querySelector('#modal .form-error').textContent.includes('Selecione o cliente'));assert.equal(saves,before);
  await modal.locator('[data-external-find]').click();
  if(scenario==='missing'){await modal.locator('[data-external-missing]').check();await modal.locator('[data-external-add]').click();await modal.locator('[data-external-professional]').nth(1).selectOption('2');await modal.locator('[data-external-service][value="8"]').waitFor({state:'attached'});await modal.locator('[data-external-service][value="8"]').check();}
  else{await modal.locator('[data-external-client="9"]').click();await modal.locator('[data-external-selected]').filter({hasText:'Maria'}).waitFor();}
  await page.setViewportSize({width:390,height:844});assert.ok(await modal.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));await submit.click();await page.waitForFunction(()=>!document.querySelector('#modal').open);assert.equal(saves,before+1);await page.setViewportSize({width:1440,height:1100});await page.locator('#status-filter').selectOption('resolved');await page.locator('#attendance-history').click();assert.match(await modal.innerText(),/Manicure · Isaura/);assert.match(await modal.innerText(),scenario==='missing'?/Cliente não localizado/:/Maria/);await page.locator('#close-modal').click();
 }
 assert.ok(!calls.some(c=>c.path.includes('commit')));assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['required customer lookup','missing customer allowed explicitly','professional services from CashBarber','multiple professionals','API error and retry','history actor and services','desktop/mobile','no new reservation']}));
}finally{await browser?.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
