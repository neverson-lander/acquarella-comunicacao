const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public'),now=Date.now(),calls=[];
const state={user:{id:'admin',name:'Administrador',role:'admin'},tenant:{id:'t',name:'Acquarella teste',phone:'5534999999999'},accounts:[{id:'a',name:'Atendimento Acquarella',channel:'whatsapp',mode:'demo',enabled:true}],conversations:[{id:'c',name:'Clara Cliente',account:'a',customer:'5534999999999',status:'open',assigned_to:'bia',assignee_name:'Beatriz',updated:now,last_inbound:now,messages:[],attendance_history:[]}],users:[],jobs:[],audit:[]};
const crm={team:[{id:'admin',name:'Administrador',role:'admin',accounts:[]},{id:'bia',name:'Beatriz',role:'agent',accounts:['a']},{id:'other',name:'Sem acesso',role:'agent',accounts:['other']},{id:'viewer',name:'Visualizador',role:'viewer',accounts:['a']}],catalog:[],tags:[],events:[],history:[],bookings:[],ads:[],opportunities:[],contacts:[],touches:[],attendance_history:[]};
const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://localhost');if(/\/api\/messages\/.*\/media/.test(url.pathname)){res.setHeader('content-type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));}if(url.pathname.startsWith('/api/')){let raw='';for await(const c of req)raw+=c;const input=raw?JSON.parse(raw):undefined;calls.push({path:url.pathname,input});let data=url.pathname==='/api/bootstrap'?{setup:false}:url.pathname==='/api/state'?{...state,server_time:Date.now()}:url.pathname==='/api/crm/state'?crm:{};
 if(url.pathname.endsWith('/messages/first-view')){const messages=state.conversations.find(c=>url.pathname.includes('/'+c.id+'/')).messages.filter(m=>input.ids.includes(m.id)&&m.direction==='in');for(const m of messages)if(!m.first_viewed_at)m.first_viewed_at=Date.now();data={messages:messages.map(m=>({id:m.id,first_viewed_at:m.first_viewed_at}))};}
 if(url.pathname.endsWith('/reply')){const signer=crm.team.find(u=>u.id===input.signature_user)||state.user;state.conversations[0].messages.push({id:'m'+calls.length,direction:'out',body:input.body,created:Date.now(),state:'simulated',operator_id:state.user.id,operator_name:state.user.name,signature_user:signer.id,signature_name:signer.name});}
 res.setHeader('content-type','application/json');return res.end(JSON.stringify(data));}
 const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));});


(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try{
  state.conversations[0].messages=[
   {id:'timed',direction:'in',body:'Olá, gostaria de agendar um horário.',created:Date.parse('2026-10-30T23:59:58-03:00'),received_at:Date.parse('2026-10-31T00:00:05-03:00'),first_viewed_at:now},
   {id:'legacy',direction:'in',body:'Mensagem anterior ao registro de recebimento.',created:now-86400000},
   {id:'out',direction:'out',body:'Bom dia! Como posso ajudar?',created:now,state:'sent'}
  ];
  const page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const original=Date.now;Date.now=()=>original()-458000;});
  const fixture='http://127.0.0.1:'+server.address().port;
  if(process.env.QA_BASE)await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());const response=await fetch(fixture+url.pathname+url.search,{method:request.method(),...(request.postData()?{body:request.postData()}:{}),headers:{'content-type':'application/json'}});await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')},body:Buffer.from(await response.arrayBuffer())});});
  await page.goto(process.env.QA_BASE||fixture);
  await page.locator('[data-attendance-scope=all]').click();
  const footer=page.locator('[data-message-id=timed] footer');
  await footer.waitFor();const info=footer.locator('.message-timing-info'),trigger=footer.getByRole('button',{name:'Ver horários da mensagem'});
  assert.equal(await info.isVisible(),false);
  await trigger.hover();await info.waitFor({state:'visible'});
  await page.mouse.move(1,1);await info.waitFor({state:'hidden'});
  await page.keyboard.press('Tab');await trigger.focus();await info.waitFor({state:'visible'});
  await page.keyboard.press('Escape');await info.waitFor({state:'hidden'});
  await trigger.hover();await info.waitFor({state:'visible'});
  const original=await info.textContent();
  assert.match(original,/Enviada pelo cliente: 30\/10\/2026 23:59:58/);
  assert.match(original,/Recebida na central: 31\/10\/2026 00:00:05/);
  assert.match(original,/Primeira visualização:/);
  const shown=await footer.locator('time').last().getAttribute('datetime');assert.ok(Math.abs(Date.parse(shown)-Date.now())<10000,'presentation must follow server despite slow browser clock');
  assert.match(await page.locator('[data-message-id=legacy] .message-timing-info').textContent(),/Recebida na central: não registrado/);
  assert.equal(await page.locator('[data-message-id=out] .message-timing').count(),0);
  await page.locator('[data-message-id=timed]').scrollIntoViewIfNeeded();
  fs.mkdirSync('artifacts/message-timing',{recursive:true});
  await page.screenshot({path:'artifacts/message-timing/'+(process.env.QA_BASE?'production-':'')+'desktop.png'});
  await page.setViewportSize({width:390,height:844});
  if(await page.locator('button[data-conversation=c]').isVisible())await page.locator('button[data-conversation=c]').click();
  await page.locator('[data-message-id=timed]').scrollIntoViewIfNeeded();
  await page.mouse.move(1,1);await trigger.blur();
  if(await info.isVisible())await page.keyboard.press('Escape');
  await trigger.tap();await info.waitFor({state:'visible'});
  assert.equal(await info.textContent(),original);
  await page.waitForFunction(()=>{const e=document.querySelector('[data-message-id=timed] .message-timing-info'),r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth;});
  const infoBox=await info.boundingBox();assert.ok(infoBox.x>=0&&infoBox.x+infoBox.width<=391);
  await page.keyboard.press('Escape');await info.waitFor({state:'hidden'});
  await trigger.tap();await info.waitFor({state:'visible'});
  assert.ok(await page.locator('body').evaluate(e=>e.scrollWidth<=innerWidth+1));
  const box=await footer.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=391);
  await page.screenshot({path:'artifacts/message-timing/'+(process.env.QA_BASE?'production-':'')+'mobile.png'});
  const fast=await browser.newPage();
  await fast.addInitScript(()=>{const original=Date.now;Date.now=()=>original()+458000;});
  if(process.env.QA_BASE)await fast.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());const response=await fetch(fixture+url.pathname+url.search,{method:request.method(),...(request.postData()?{body:request.postData()}:{}),headers:{'content-type':'application/json'}});await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')},body:Buffer.from(await response.arrayBuffer())});});
  await fast.goto(process.env.QA_BASE||fixture);await fast.locator('[data-attendance-scope=all]').click();
  const fastStamp=await fast.locator('[data-message-id=timed] footer time').last().getAttribute('datetime');assert.ok(Math.abs(Date.parse(fastStamp)-Date.now())<10000,'presentation must follow server despite fast browser clock');await fast.close();
  assert.deepEqual(errors,[]);
  console.log('PASS: minimal icon, hover/focus/Escape/touch, persistent first view, mobile tooltip bounds, independent of browser skew.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
