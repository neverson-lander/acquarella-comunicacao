const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const now=Date.now(),root=path.resolve('vercel-app/public'),calls=[];
const quote={clientId:'123',clientName:'Cliente de teste',professionalName:'Isaura',service:'Manicure Tradicional',price:4500,duration:50,date:'2026-10-22',start:'13:00',end:'13:50'};
const centralBookings=[{id:'11111111-1111-4111-8111-111111111111',conversation:'c',actor:'u',quote,receipt:{externalId:'987'},confirmed_at:now-60000},{id:'22222222-2222-4222-8222-222222222222',conversation:'c',actor:'u',quote:{...quote,service:'Pedicure no plano',price:0,start:'14:00',end:'14:50'},receipt:{externalId:'988'},confirmed_at:now-30000}];
const bookings=[];let mode='found',failDirectory=false,saves=0;
const state={user:{id:'u',name:'Ana',role:'admin'},tenant:{id:'t',name:'Teste',phone:'5534999999999'},accounts:[{id:'a',name:'WhatsApp',channel:'whatsapp',mode:'live',enabled:true}],conversations:[{id:'c',name:quote.clientName,customer:'5511999999999',account:'a',status:'open',assigned_to:'u',assignee_name:'Ana',updated:now,last_inbound:now,messages:[],attendance_history:[]}],users:[],jobs:[],audit:[]};
const crm={team:[{id:'u',name:'Ana',role:'admin',accounts:['a']}],opportunities:[{id:'o',conversation:'c',contact:'ct',customer:'5511999999999',customer_name:quote.clientName,channel:'whatsapp',mode:'live',owner:'u',first_contact:now-90*86400000,stage:'new'}],contacts:[],catalog:[],tags:[],touches:[{id:'touch',opportunity:'o',source:'paid',ad_id:'123456',evidence:'webhook',created:now-90*86400000}],events:[],ads:[{ad_id:'123456',ad_name:'Anúncio de teste',campaign_id:'camp',campaign_name:'Campanha de teste'}],history:[],attendance_history:[],bookings};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};calls.push({path:url.pathname,input});let result={};
  if(url.pathname==='/api/bootstrap')result={setup:false};
  if(url.pathname==='/api/state')result={...state,server_time:Date.now()};
  if(url.pathname==='/api/crm/state')result=crm;
  if(url.pathname==='/api/cashbarber/closure')result={bookings,link:null};
  if(url.pathname==='/api/cashbarber/professionals'){if(failDirectory){failDirectory=false;res.statusCode=503;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'Consulta temporariamente indisponível'}));return;}result={professionals:[{id:'1',name:'Miryam Luiza Silva Clemente'},{id:'2',name:'Ana'}]};}
  if(url.pathname==='/api/cashbarber/services')result={services:[{id:'7',name:'Manicure Tradicional'},{id:'8',name:'Manicure Tradicional - Avulso (NÃO É VÁLIDO PARA CLIENTES DE ASSINATURA - PACOTE)'},{id:'9',name:'Pedicure Tradicional'},{id:'10',name:'Pedicure Tradicional - Avulso NÃO É VÁLIDO PARA CLIENTES DE ASSINATURA - Promoção'},{id:'11',name:'Esmaltação Mão'},{id:'12',name:'Esmaltação Pé'},{id:'13',name:'Spa dos pés e hidratação'}]};
  if(url.pathname==='/api/cashbarber/clients')result={clients:mode==='found'?[{id:'9',name:'Fabiana Kelly de Carvalho'}]:[]};
  if(url.pathname==='/api/cashbarber/client')result={client:{id:'9',name:'Fabiana Kelly de Carvalho'}};
  if(url.pathname==='/api/conversations/c/status'){
   saves++;assert.equal(input.source,'paid');assert.equal(input.ad_id,'123456');assert.equal(input.had_scheduling,false);result={ok:true};
  }
  res.setHeader('content-type','application/json');return res.end(JSON.stringify(result));
 }
 res.setHeader('content-security-policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
 const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
 res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});

(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch();const page=await browser.newPage();const url='http://127.0.0.1:'+server.address().port;
 const open=async()=>{await page.goto(url);await page.locator('[data-attendance-scope=mine]').click();await page.locator('#resolve').click();await page.locator('#modal').waitFor({state:'visible'})};
 for(const missingAd of [false,true]){
  if(missingAd)crm.ads=[];
  await open();const source=page.locator('#modal select[name=source]'),ad=page.locator('#modal select[name=ad_id]');
  assert.equal(await source.inputValue(),'paid');assert.equal(await source.isDisabled(),true);
  assert.equal(await ad.isVisible(),true);assert.equal(await ad.inputValue(),'123456');assert.equal(await ad.isDisabled(),true);
  await page.selectOption('#modal [name=had_scheduling]','no');await page.locator('#modal .modal-footer .primary').click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
 }
 assert.equal(saves,2);
 crm.touches[0].evidence='manual';await open();assert.equal(await page.locator('#modal select[name=source]').isEnabled(),true);assert.equal(await page.locator('#modal select[name=ad_id]').isEnabled(),true);
 await page.selectOption('#modal select[name=source]','organic');assert.equal(await page.locator('#modal select[name=ad_id]').isVisible(),false);
 console.log('PASS: closure locks automatic paid origin/ad, submits disabled values, resolves missing ad catalogue, and keeps manual attribution editable under production CSP.');
}finally{await browser?.close();server.close()}})().catch(e=>{console.error(e);process.exitCode=1});
