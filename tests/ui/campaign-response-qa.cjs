const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public');
const server=http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><meta charset="utf-8"><dialog><form id="modal-form"></form></dialog>');}
 const file=path.resolve(root,'.'+req.url);if(!file.startsWith(root+path.sep)){res.statusCode=404;return res.end();}
 try{res.setHeader('content-type','text/javascript');res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(async()=>{
  const {createCampaignBulkUi}=await import('/campaign-bulk.js'),{readApiResponse}=await import('/api-response.mjs');window.calls=[];window.saved=[];let failed=false;
  const modal=(_title,html)=>{document.querySelector('form').innerHTML=html+'<p class="form-error"></p><button type="button" id="cancel">Cancelar</button><button class="primary">Consultar</button>';document.querySelector('dialog').showModal();};
  const api=async(action,input)=>{
   if(action.endsWith('candidates'))return {items:[{conversation:'fatima',client:'Fatima Albano'},{conversation:'next',client:'Próxima cliente'}],preserved:0};
   calls.push(input.conversation);if(!failed){failed=true;return readApiResponse(new Response('',{status:502}));}
   return {status:'none_in_period',matches:[],saved:true};
  };
  await createCampaignBulkUi({api,modal,connect:()=>{},canConnect:()=>true,onReport:(item)=>saved.push(item.conversation),esc:s=>String(s)})({});
 });
 await page.locator('.primary').click();await page.getByRole('button',{name:'Retomar consulta',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls),['fatima']);assert.deepEqual(await page.evaluate(()=>saved),[]);
 assert.equal(await page.locator('[data-bulk-results] article').count(),0);assert.match(await page.locator('.form-error').innerText(),/temporariamente indisponível/);
 assert.match(await page.locator('[data-bulk-progress]').innerText(),/0 de 2/);assert.equal(await page.locator('[data-bulk-renew]').isHidden(),true);
 await page.locator('.primary').click();await page.getByRole('button',{name:'Fechar',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls),['fatima','fatima','next']);assert.deepEqual(await page.evaluate(()=>saved),['fatima','next']);
 assert.equal(await page.locator('[data-bulk-results] article').count(),2);assert.doesNotMatch(await page.locator('[data-bulk-results]').innerText(),/JSON/);assert.deepEqual(errors,[]);
 await page.screenshot({path:path.resolve('artifacts/campaign-response-release/recovery.png')});
 console.log('Empty 502 pauses without skipping Fatima; resume retries her then processes the next customer.');
}finally{await browser.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e);process.exitCode=1;});
