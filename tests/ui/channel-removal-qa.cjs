const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public'),now=Date.now(),calls=[];
const state={user:{id:'u',name:'Ana',role:'admin'},tenant:{id:'t',name:'Teste',phone:'5511999999999'},accounts:[{id:'a',name:'WhatsApp antigo',channel:'whatsapp',transport:'qr',mode:'live',enabled:true,alerts_phones:[]},{id:'b',name:'Instagram',channel:'instagram',mode:'live',enabled:true,bridge:'a',forwarding_enabled:true,alerts_phones:[]}],conversations:[{id:'c',name:'Cliente na fila',customer:'5511888888888',account:'a',status:'open',assigned_to:null,last_inbound:0,updated:now-25*60000,messages:[],attendance_history:[]}],users:[],jobs:[],audit:[]};
const crm={team:[],opportunities:[],contacts:[],catalog:[],tags:[],touches:[],events:[],ads:[],history:[]};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};calls.push({path:url.pathname,input});let result={};
    if(url.pathname==='/api/bootstrap')result={setup:false};if(url.pathname==='/api/state')result={...state,server_time:Date.now()};if(url.pathname==='/api/crm/state')result=crm;
    if(url.pathname==='/api/accounts/a/delete'){
      assert.deepEqual(input,{name:'WhatsApp antigo',confirmed:true});state.accounts[0].deleted_at=Date.now();state.accounts[0].enabled=false;state.accounts[1].bridge=null;state.accounts[1].forwarding_enabled=false;state.conversations[0].status='resolved';result={ok:true};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result));return;
  }
  const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
  res.setHeader('content-type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));try{
  browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  await page.goto('http://127.0.0.1:'+server.address().port);await page.locator('#queue-wait').filter({hasText:'Maior espera: 25 min'}).waitFor();assert.match(await page.locator('.wait-badge').innerText(),/Espera 25 min/);
  await page.locator('[data-view=channels]').click();await page.locator('[data-delete-account=a]').click();const dialog=page.locator('#modal');
  assert.match(await dialog.innerText(),/Histórico|histórico/);assert.match(await dialog.innerText(),/Instagram/);
  const submit=dialog.getByRole('button',{name:'Excluir canal',exact:true});await submit.click();assert.equal(calls.filter(c=>c.path.endsWith('/delete')).length,0);
  await dialog.locator('[name=confirmed]').check();fs.mkdirSync('output',{recursive:true});await page.screenshot({path:'output/channel-removal-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.ok(await dialog.evaluate(e=>e.getBoundingClientRect().right<=innerWidth));await page.screenshot({path:'output/channel-removal-mobile.png'});
  await submit.click();await page.waitForFunction(()=>!document.querySelector('#modal').open);await page.waitForFunction(()=>!document.querySelector('[data-delete-account=a]'));
  assert.equal(calls.filter(c=>c.path.endsWith('/delete')).length,1);assert.equal(await page.locator('[data-edit-account=b]').count(),1);
  await page.setViewportSize({width:1440,height:1000});await page.locator('[data-view=inbox]').click();await page.locator('[data-attendance-scope=all]').click();await page.locator('#status-filter').selectOption('resolved');await page.locator('button[data-conversation=c]').click();
  assert.match(await page.locator('#chat').innerText(),/Canal excluído/);assert.equal(await page.locator('#resolve').isDisabled(),true);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,checks:['queue wait without inbound timestamp','per-conversation wait','delete confirmation','dependent channel warning','desktop/mobile','single deletion','channel disappears','historical conversation remains read-only']}));
}finally{await browser?.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
