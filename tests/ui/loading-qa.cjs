const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public'),now=Date.now(),calls={};
let logged=false,failTenant=true,failReply=true;
const state={user:{id:'u',name:'Ana',role:'admin'},tenant:{id:'t',name:'Teste',phone:'5534988748139'},accounts:[{id:'a',name:'WhatsApp',channel:'whatsapp',mode:'live',bridge:'a'}],conversations:[{id:'c',name:'Cliente',customer:'5511999999999',account:'a',status:'open',assigned_to:null,updated:now,last_inbound:now,messages:[],attendance_history:[]}],users:[],jobs:[],audit:[]};
const crm={team:[],opportunities:[],contacts:[],catalog:[],tags:[],touches:[],events:[],ads:[{ad_id:'123',ad_name:'Teste'}],history:[]};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  calls[url.pathname]=(calls[url.pathname]||0)+1;
  await new Promise(r=>setTimeout(r,350));
  res.setHeader('content-type','application/json');
  let result={};
  if(url.pathname==='/api/bootstrap')result={setup:false};
  if(url.pathname==='/api/login')logged=true;
  if(url.pathname==='/api/logout')logged=false;
  if(url.pathname==='/api/state'){if(!logged){res.statusCode=401;result={error:'Entre na central.'};}else result={...state,server_time:Date.now()};}
  if(url.pathname==='/api/crm/state')result=crm;
  if(url.pathname==='/api/tenant'&&failTenant){res.statusCode=500;result={error:'Falha de teste. Tente novamente.'};}
  if(url.pathname.endsWith('/claim')){state.conversations[0].assigned_to='u';state.conversations[0].assignee_name='Ana';}
  if(url.pathname.endsWith('/reply')&&failReply){res.statusCode=500;result={error:'Envio falhou. Tente novamente.'};}
  if(url.pathname.endsWith('/diagnostics'))result={connected:true,profile:{name:'Teste'}};
  if(url.pathname.endsWith('/sync'))result={updated:1,pending:0};
  res.end(JSON.stringify(result));return;
 }
 const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);
 if(!file.startsWith(root)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
 res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const real=setInterval;window.setInterval=(fn,ms,...args)=>{if(ms===5000){window.__poll=fn;return 1;}return real(fn,ms,...args);};});
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.locator('.initial-loading').waitFor();
 await page.locator('#auth').waitFor();
 await page.locator('[name=email]').fill('ana@example.com');await page.locator('[name=password]').fill('abcdefghijkl');
 await page.locator('#auth button').click();
 assert.equal(await page.locator('#auth button').textContent(),'Entrando…');assert.equal(await page.locator('#auth button').isDisabled(),true);
 await page.locator('#auth').evaluate(f=>f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await page.locator('#claim-attendance').waitFor();assert.equal(calls['/api/login'],1);
 await page.locator('#claim-attendance').click();assert.equal(await page.locator('#claim-attendance').textContent(),'Assumindo atendimento…');
 await page.locator('#reply textarea:not([disabled])').waitFor();
 await page.locator('#reply textarea').fill('Rascunho preservado');await page.locator('#reply .primary').click();
 assert.equal(await page.locator('#reply .primary').textContent(),'Enviando…');
 await page.waitForFunction(()=>document.querySelector('#reply .primary').disabled===false);
 assert.equal(await page.locator('#reply textarea').inputValue(),'Rascunho preservado');
 failReply=false;await page.locator('#reply .primary').click();await page.waitForFunction(()=>document.querySelector('#reply textarea').value==='');
 await page.waitForFunction(()=>document.querySelector('#action-status').hidden);await page.locator('#identify').click();await page.locator('#modal-form .modal-footer .primary').click();
 assert.equal(await page.locator('#modal-form').getAttribute('aria-busy'),'true');assert.equal(await page.locator('#cancel').isDisabled(),true);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#modal').evaluate(d=>d.open),true);
 await page.waitForFunction(()=>!document.querySelector('#modal').open);
 await page.locator('[data-view=settings]').click();await page.locator('#tenant-form .primary').click();
 assert.equal(await page.locator('#tenant-form .primary').textContent(),'Salvando configurações…');
 await page.waitForFunction(()=>!document.querySelector('#tenant-form .primary').disabled);
 assert.match(await page.locator('#toast').textContent(),/Falha de teste/);
 failTenant=false;await page.locator('#tenant-form .primary').click();await page.waitForFunction(()=>!document.querySelector('#action-status').hidden);await page.waitForFunction(()=>document.querySelector('#action-status').hidden);
 await page.locator('[data-view=crm]').click();await page.locator('[data-crm-tab=marketing]').click();await page.locator('#sync-ads').click();
 assert.equal(await page.locator('#sync-ads').textContent(),'Atualizando anúncios…');await page.waitForFunction(()=>document.querySelector('#action-status').hidden);
 await page.locator('[data-enrich]').click();assert.equal(await page.locator('[data-enrich]').textContent(),'Consultando Meta…');await page.waitForFunction(()=>document.querySelector('#action-status').hidden);
 await page.locator('#refresh').click();const before=calls['/api/state'];await page.evaluate(()=>window.__poll());assert.equal(calls['/api/state'],before);
 fs.mkdirSync('output/loading',{recursive:true});await page.screenshot({path:'output/loading/desktop.png'});await page.waitForFunction(()=>document.querySelector('#action-status').hidden);
 await page.setViewportSize({width:390,height:844});await page.locator('#refresh').click();await page.screenshot({path:'output/loading/mobile.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.waitForFunction(()=>document.querySelector('#action-status').hidden);
 await page.locator('#logout').click();await page.locator('#auth').waitFor();
 assert.deepEqual(errors,[]);console.log('PASS delayed loading, login duplicate prevention, claim, reply failure/retry and draft, modal save/Escape lock, settings failure/retry, CRM sync/enrich, silent polling, desktop/mobile, logout, no browser errors.');
 }catch(e){console.error(e);process.exitCode=1;}finally{await browser?.close();await new Promise(r=>server.close(r));}})();
