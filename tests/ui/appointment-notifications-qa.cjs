const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public');
const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/cashbarber.css"><main id="settings"></main></html>');}
  const file=path.resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!file.startsWith(root+path.sep)){res.statusCode=404;return res.end();}
  try{res.setHeader('content-type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async()=>{
      const {createCashbarberUi}=await import('/cashbarber.js');window.calls=[];
      const state={user:{role:'admin'},accounts:[{id:'qr',name:'Recepção Acquarella',channel:'whatsapp',transport:'qr',mode:'live',enabled:true},{id:'meta',name:'API oficial',channel:'whatsapp',transport:'meta',mode:'live',enabled:true}]};
      let settings={enabled:false,account:null,last_run:null,delivery_mode:'manual'};
      const api=async(action,input)=>{window.calls.push({action,input});if(action==='cashbarber/daily-actions')return {settings:[{feature:'subscriptions',enabled:false},{feature:'comandas',enabled:false}],runs:[],items:[]};if(action==='cashbarber/notifications'){if(input.save)settings={enabled:input.enabled,account:input.account,delivery_mode:input.delivery_mode,last_run:Date.now()};return {settings,history:[{external_id:'123',kind:'reminder',state:'uncertain',error:'Entrega não confirmada. Confira o WhatsApp.',due:Date.now(),body:'Olá, Cliente!\nLembrete do seu agendamento.'}]};}return {connected:true};};
      createCashbarberUi({api,getState:()=>state,toast:()=>{}}).settings(document.querySelector('#settings'));
    });
    await page.getByRole('heading',{name:'Conexão e consulta da agenda',exact:true}).waitFor();
    assert.equal(await page.locator('.appointment-notifications select[name="account"] option').count(),2);
    assert.equal(await page.locator('input[name="automatic"]').isDisabled(),true);
    await page.locator('.appointment-notifications input[name="enabled"]').check();await page.locator('.appointment-notifications select[name="account"]').selectOption('qr');
    await page.getByRole('button',{name:'Salvar configurações da agenda',exact:true}).click();await page.getByText(/Configuração salva/).waitFor();
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.input?.save&&c.input.enabled&&c.input.account==='qr')),true);
    const automatic=page.getByLabel('Enviar mensagens automaticamente',{exact:true});
    await automatic.check();await page.getByRole('button',{name:'Salvar configurações da agenda',exact:true}).click();await page.getByText(/Configuração salva.*Envio automático ligado/).waitFor();
    await page.getByRole('button',{name:'Atualizar configuração',exact:true}).click();assert.equal(await automatic.isChecked(),true);
    await automatic.uncheck();await page.getByRole('button',{name:'Salvar configurações da agenda',exact:true}).click();await page.getByText(/Configuração salva.*Envio automático desligado/).waitFor();
    assert.equal(await page.locator('.appointment-notifications input[name="enabled"]').isChecked(),true);
    await automatic.check();await page.locator('.appointment-notifications input[name="enabled"]').uncheck();assert.equal(await automatic.isChecked(),false);assert.equal(await automatic.isDisabled(),true);
    await page.getByRole('button',{name:'Salvar configurações da agenda',exact:true}).click();await page.getByText(/Configuração salva/).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.input?.save).map(c=>c.input.delivery_mode)),['manual','automatic','manual','manual']);
    await page.getByRole('button',{name:'Conectar / renovar sessão',exact:true}).click();
    assert.equal(await page.locator('input[name="remember"]').count(),0);
    await page.locator('input[name="email"]').fill('teste@example.invalid');await page.locator('input[name="password"]').fill('test-only-password');
    await page.getByRole('button',{name:'Conectar',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.action==='cashbarber/login'&&c.input.remember===undefined)),true);
    await page.getByRole('button',{name:'Conectar conta da automação',exact:true}).click();
    await page.locator('input[name="email"]').fill('automation@example.invalid');await page.locator('input[name="password"]').fill('automation-test');
    await page.getByRole('button',{name:'Conectar',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.action==='cashbarber/notification-connection'&&c.input.action==='login')),true);
    assert.equal(await page.locator('.appointment-notifications [data-history]').count(),0);
    const output=path.resolve('artifacts/appointment-notifications');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'settings.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'settings-mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'settings should not overflow on mobile');
    assert.deepEqual(errors,[]);console.log('Settings, QR channel selection, save, encrypted-auth preference and mobile layout passed.');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
