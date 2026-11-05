const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public'),now=Date.now();let saves=0;
const state={user:{id:'u',name:'Ana',role:'admin'},tenant:{id:'t',name:'Teste',phone:'5534999999999'},accounts:[{id:'a',name:'WhatsApp da equipe',channel:'whatsapp',mode:'live',enabled:true}],conversations:['1','2','3'].map(id=>({id,name:'Cliente '+id,customer:'551199999999'+id,account:'a',status:'open',assigned_to:null,assigned_at:null,updated:now,last_inbound:now,messages:[],attendance_history:[]})),users:[],jobs:[],audit:[]};
const crm={team:[],opportunities:[],contacts:[],catalog:[],tags:[],touches:[],events:[],ads:[],history:[]};
const items=state.conversations.map(({id,name,account,updated,last_inbound})=>({id,name,account,account_name:'WhatsApp da equipe',updated,last_inbound,message_count:'0'}));
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    const chunks=[];for await(const c of req)chunks.push(c);const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};let value={};
    if(url.pathname==='/api/bootstrap')value={setup:false};
    if(url.pathname==='/api/state')value={...state,server_time:Date.now()};
    if(url.pathname==='/api/crm/state')value=crm;
    if(url.pathname==='/api/conversations/queue-close-preview')value={items,hasMore:true};
    if(url.pathname==='/api/conversations/queue-close'){
      saves++;assert.equal(input.reason,'Atendidos pelo celular');assert.deepEqual(input.items.map(i=>i.id),['1','2']);assert.equal(input.items[0].message_count,'0');assert.equal(input.items[0].updated,now);
      await new Promise(r=>setTimeout(r,100));state.conversations[0].status='resolved';value={ok:true,closed:['1'],skipped:1};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return;
  }
  const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
  res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  state.conversations[0].attendance_history=[{id:'h',created:now,actor:'u',actor_name:'Ana',action:'Atendimento encerrado em massa sem início',reason:'Atendido pelo celular <script>window.injected=true</script>'}];
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('.conversation[data-conversation="1"]').click();await page.locator('#attendance-history').click();
  assert.match(await page.locator('#modal').innerText(),/Motivo: Atendido pelo celular <script>/);assert.match(await page.locator('#modal').innerText(),/Ana/);assert.equal(await page.evaluate(()=>window.injected),undefined);await page.locator('#close-modal').click();
  await page.locator('#close-queue').click();
  const dialog=page.locator('#modal');await dialog.getByRole('heading',{name:'Encerrar atendimentos da fila'}).waitFor();
  assert.match(await dialog.innerText(),/200 mais antigos/);assert.equal(await dialog.locator('[name=queue_ids]').count(),3);
  await dialog.locator('[data-queue-select-all]').uncheck();assert.equal(await dialog.getByRole('button',{name:'Encerrar selecionados (0)',exact:true}).isDisabled(),true);
  await dialog.locator('[name=queue_ids][value="1"]').check();await dialog.locator('[name=queue_ids][value="2"]').check();
  assert.equal(await dialog.locator('[data-queue-select-all]').evaluate(e=>e.indeterminate),true);
  await dialog.getByRole('button',{name:'Encerrar selecionados (2)',exact:true}).click();assert.equal(saves,0);
  await dialog.locator('[name=reason]').fill('Atendidos pelo celular');assert.match(await dialog.innerText(),/Responsável: Ana/);
  fs.mkdirSync('output',{recursive:true});await page.screenshot({path:'output/bulk-queue-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));await page.screenshot({path:'output/bulk-queue-mobile.png'});
  await dialog.getByRole('button',{name:'Encerrar selecionados (2)',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#modal').open);
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('1 preservado'));assert.equal(saves,1);
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-attendance-scope=mine]').click();assert.equal(await page.locator('#close-queue').isHidden(),true);
  state.user.role='agent';await page.reload();await page.locator('[data-attendance-scope=queue]').waitFor();assert.equal(await page.locator('#close-queue').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['review and selection','select all and empty guard','reason required and sent','actor and escaped reason visible in history','snapshot sent','partial result','desktop/mobile','restricted action','queue-only button']}));
}finally{await browser?.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
