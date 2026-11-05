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
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});
 try{
 const conversation=state.conversations[0],message=(id,seen)=>({id,direction:'in',body:'Mensagem '+id+' para testar a visualização na tela.',created:now-2000,received_at:now-1000,...(seen?{first_viewed_at:now-500}:{})});
 conversation.messages=[message('hidden-first'),...Array.from({length:45},(_,i)=>message('known-'+i,true)),message('visible-last')];
 const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__qaActive=false;document.hasFocus=()=>window.__qaActive;const real=Date.now;Date.now=()=>real()-458000;});
 const fixture='http://127.0.0.1:'+server.address().port;
 if(process.env.QA_BASE)await page.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());const response=await fetch(fixture+url.pathname+url.search,{method:request.method(),...(request.postData()?{body:request.postData()}:{}),headers:{'content-type':'application/json'}});await route.fulfill({status:response.status,headers:{'content-type':response.headers.get('content-type')},body:Buffer.from(await response.arrayBuffer())});});
 await page.goto(process.env.QA_BASE||fixture);await page.locator('[data-attendance-scope=all]').click();await page.locator('[data-message-id=visible-last]').waitFor();
 await page.waitForTimeout(250);assert.equal(calls.filter(c=>c.path.endsWith('/messages/first-view')).length,0,'inactive windows must not register views');
 await page.evaluate(()=>{window.__qaActive=true;window.dispatchEvent(new Event('focus'));});
 await page.waitForFunction(()=>document.querySelector('[data-message-id=visible-last] .message-timing-info').textContent.includes('Primeira visualização: ')&&!document.querySelector('[data-message-id=visible-last] .message-timing-info').textContent.includes('ainda não registrada'));
 assert.ok(conversation.messages.at(-1).first_viewed_at);assert.equal(conversation.messages[0].first_viewed_at,undefined,'offscreen history must stay unseen');
 const first=conversation.messages.at(-1).first_viewed_at;assert.ok(first>=now&&first<=Date.now());
 assert.ok(calls.filter(c=>c.path.endsWith('/messages/first-view')).every(c=>!c.input.ids.includes('hidden-first')));
 await page.locator('[data-message-id=hidden-first]').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>!document.querySelector('[data-message-id=hidden-first] .message-timing-info').textContent.includes('ainda não registrada'));
 assert.ok(conversation.messages[0].first_viewed_at);
 const count=calls.filter(c=>c.path.endsWith('/messages/first-view')).length;
 await page.reload();await page.locator('[data-attendance-scope=all]').click();await page.waitForTimeout(250);
 assert.equal(conversation.messages.at(-1).first_viewed_at,first);assert.equal(calls.filter(c=>c.path.endsWith('/messages/first-view')).length,count,'reload must not overwrite or resubmit known views');
 assert.deepEqual(errors,[]);console.log('PASS: inactive window excluded, offscreen messages excluded, visible messages recorded, server time despite browser skew, scroll records remaining message, reload preserves first view.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
