const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const now=Date.now(),root=path.resolve('vercel-app/public'),calls=[];
const quote={clientId:'123',clientName:'Cliente de teste',professionalName:'Isaura',service:'Manicure Tradicional',price:4500,duration:50,date:'2026-10-22',start:'13:00',end:'13:50'};
const bookings=[{id:'11111111-1111-4111-8111-111111111111',conversation:'c',actor:'u',quote,receipt:{externalId:'987'},confirmed_at:now-60000},{id:'22222222-2222-4222-8222-222222222222',conversation:'c',actor:'u',quote:{...quote,service:'Pedicure no plano',price:0,start:'14:00',end:'14:50'},receipt:{externalId:'988'},confirmed_at:now-30000}];
const state={user:{id:'u',name:'Ana',role:'admin'},tenant:{id:'t',name:'Teste',phone:'5534999999999'},accounts:[{id:'a',name:'WhatsApp',channel:'whatsapp',mode:'live',enabled:true}],conversations:[{id:'c',name:quote.clientName,customer:'5511999999999',account:'a',status:'open',assigned_to:'u',assignee_name:'Ana',updated:now,last_inbound:now,messages:[],attendance_history:[]}],users:[],jobs:[],audit:[]};
const crm={team:[{id:'u',name:'Ana',role:'admin',accounts:['a']}],opportunities:[{id:'o',conversation:'c',contact:'ct',customer:'5511999999999',customer_name:quote.clientName,channel:'whatsapp',mode:'live',owner:'u',first_contact:now-90*86400000,stage:'new'}],contacts:[],catalog:[],tags:[],touches:[{id:'touch',opportunity:'o',source:'paid',ad_id:'123456',evidence:'webhook',created:now-90*86400000}],events:[],ads:[{ad_id:'123456',ad_name:'Anúncio de teste',campaign_id:'camp',campaign_name:'Campanha de teste'}],history:[],attendance_history:[],bookings};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};calls.push({path:url.pathname,input});let result={};
  if(url.pathname==='/api/bootstrap')result={setup:false};
  if(url.pathname==='/api/state')result={...state,server_time:Date.now()};
  if(url.pathname==='/api/crm/state')result=crm;
  if(url.pathname==='/api/cashbarber/closure'){assert.equal(input.conversation,'c');result={bookings};}
  if(url.pathname==='/api/conversations/c/status'){
   assert.equal(input.had_scheduling,true);assert.deepEqual(input.cash_booking_ids,bookings.map(b=>b.id));assert.deepEqual(input.scheduled_services,[]);assert.equal(input.source,'paid');assert.equal(input.ad_id,'123456');
   state.conversations[0].status='resolved';result={ok:true};
  }
  res.setHeader('content-type','application/json');return res.end(JSON.stringify(result));
 }
 const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
 res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('[data-attendance-scope=mine]').click();await page.locator('#resolve').click();
 const modal=page.locator('#modal');await modal.locator('[data-booked-services]').waitFor();assert.match(await modal.innerText(),/Manicure Tradicional · R\$\s*45,00/);assert.match(await modal.innerText(),/Pedicure no plano · R\$\s*0,00/);assert.match(await modal.innerText(),/Total agendado: R\$\s*45,00/);
 assert.equal(await modal.locator('[name=had_scheduling]').inputValue(),'yes');assert.equal(await modal.locator('[name=scheduled_services]').getAttribute('required'),null);
 fs.mkdirSync('output',{recursive:true});await page.screenshot({path:'output/booking-closure-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'output/booking-closure-mobile.png'});assert.equal(await modal.evaluate(el=>el.getBoundingClientRect().right<=window.innerWidth),true);
 await modal.getByRole('button',{name:'Encerrar atendimento',exact:true}).click();await modal.waitFor({state:'hidden'});assert.equal(calls.filter(c=>c.path==='/api/conversations/c/status').length,1);
 await page.setViewportSize({width:1440,height:1100});await page.locator('[data-view=metrics]').click();const report=page.getByRole('region',{name:'Agendamentos e retorno por campanha'});await report.waitFor();
 assert.match(await report.innerText(),/Campanha de teste/);assert.match(await report.innerText(),/Automática/);assert.equal(await report.locator('tbody tr').count(),3);await report.scrollIntoViewIfNeeded();await page.screenshot({path:'output/booking-report-desktop.png'});
 const download=page.waitForEvent('download');await page.locator('#metrics-export').click();const csv=await download;await csv.saveAs(path.resolve('output/booking-report.csv'));const content=fs.readFileSync(path.resolve('output/booking-report.csv'),'utf8');assert.ok(content.includes('Preço da reserva centavos'));assert.ok(content.includes('4500'));assert.ok(content.includes('Pedicure no plano'));
 await page.locator('[data-metrics-filter=bookingQuery]').fill('Pedicure');await page.locator('[data-metrics-filter=bookingQuery]').press('Tab');await page.waitForFunction(()=>document.querySelector('[aria-label="Agendamentos e retorno por campanha"] tbody')?.innerText.includes('Campanha de teste'));assert.equal(await report.locator('tbody tr').count(),2);
 await page.setViewportSize({width:390,height:844});await page.locator('#toggle-sidebar').click();await report.scrollIntoViewIfNeeded();assert.equal(await report.evaluate(el=>el.getBoundingClientRect().right<=window.innerWidth),true);await page.screenshot({path:'output/booking-report-mobile.png'});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:['closure auto includes confirmed services','frozen prices including zero plan','closure without catalogue selections','same-tenant booking identifiers submitted once','automatic campaign for older contact','booking totals separate from sales','CSV download','booking search','mobile']}));
 }finally{await browser?.close();server.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
