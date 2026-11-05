const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public'),dir=path.resolve('artifacts/campaign-analytics-release');
const state=JSON.parse(fs.readFileSync(path.join(dir,'state-before.json'),'utf8').replace(/^\uFEFF/,''));
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/state'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(state));}
 if(url.pathname==='/'){
  res.setHeader('content-type','text/html; charset=utf-8');
  return res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/crm.css"><link rel="stylesheet" href="/attendance.css"><link rel="stylesheet" href="/metrics.css"><style>main{margin:0 auto;max-width:1300px;padding:24px;min-width:0}#content,#crm-workspace{min-width:0}@media(max-width:650px){main{padding:14px}}</style></head><body><main><div id="content"></div><div id="crm-workspace"></div></main><dialog id="modal"></dialog><script type="module">
   import {createMetricsUi} from '/metrics.js';import {createCampaignAttendancesUi} from '/campaign-attendances.js';import {campaignAnalysis} from '/campaign-analysis.mjs';
   const state=await fetch('/state').then(r=>r.json());const analysis=campaignAnalysis(state.crm);window.expected=analysis.summary;window.actions=[];window.investmentCalls=[];const investmentApi=async(action,input)=>{window.investmentCalls.push({action,input});if(window.failSpend)throw Error('Consulta Meta indisponível.');return {from:input.from||'2026-10-01',to:input.to||'2026-11-04',checked_at:Date.now(),campaigns:[{id:analysis.groups[0].id,name:analysis.groups[0].name,spend_cents:2500},{id:'99999999999999999',name:'Campanha sem contatos',spend_cents:500}],known_campaign_ids:[analysis.groups[0].id],cached:false};};
   if(new URL(location).searchParams.has('campaign'))createCampaignAttendancesUi({getState:()=>state,openConversation:id=>window.actions.push(id),api:async()=>{throw Error('Unexpected mutation');},modal:()=>{},toast:()=>{},connect:()=>{}}).render();
   else createMetricsUi({getState:()=>state,api:investmentApi}).render();window.ready=true;
  </script></body></html>`);
 }
 const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
 res.setHeader('content-type',file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/javascript; charset=utf-8');res.end(fs.readFileSync(file));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(stamp=>{Date.now=()=>stamp;},state.capturedAt);const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base);await page.waitForFunction(()=>window.ready);await page.locator('#metrics-all').click();
 assert.equal(await page.locator('.metrics-panel:visible').count(),1);assert.equal(await page.locator('.metrics-kpis-main .metrics-card:visible').count(),6);
 await page.screenshot({path:path.join(dir,'metrics-overview-desktop.png'),fullPage:true});
 for(const id of ['campaigns','bookings','team','quality']){await page.locator('[data-metrics-tab="'+id+'"]').click();assert.equal(await page.locator('.metrics-panel:visible').getAttribute('data-metrics-panel'),id);}
 await page.locator('[data-metrics-tab=campaigns]').click();const expected=await page.evaluate(()=>window.expected);
 assert.equal(await page.locator('[data-metrics-panel=campaigns] .metrics-card').nth(1).locator('strong').innerText(),String(expected.scheduled));
 assert.equal(await page.locator('[data-metrics-panel=campaigns] .metrics-card').nth(6).locator('strong').innerText(),String(expected.first_conversion_return));
 await page.screenshot({path:path.join(dir,'metrics-campaigns-desktop.png'),fullPage:true});
 await page.locator('[data-investment-load]').click();await page.locator('[data-investment-view=direct]').waitFor();assert.match(await page.locator('#campaign-investment').innerText(),/R\$\s*30,00/);assert.match(await page.locator('#campaign-investment').innerText(),/Campanha sem contatos/);await page.locator('[data-investment-campaign]').selectOption({index:1});assert.match(await page.locator('#campaign-investment .metrics-card').first().innerText(),/R\$\s*25,00/);await page.locator('[data-investment-campaign]').selectOption('');await page.locator('[data-investment-view=acquisition]').click();assert.equal(await page.locator('[data-investment-view=acquisition]').getAttribute('aria-selected'),'true');await page.screenshot({path:path.join(dir,'investment-desktop.png'),fullPage:true});

 await page.locator('[data-metrics-filter=channel]').selectOption('whatsapp');assert.equal(await page.locator('[data-metrics-tab=campaigns]').getAttribute('aria-selected'),'true');assert.equal(await page.locator('[data-investment-load]').isDisabled(),true);
 await page.locator('[data-metrics-filter=channel]').selectOption('');
 const downloadPromise=page.waitForEvent('download');await page.locator('#metrics-export').click();const download=await downloadPromise;await download.saveAs(path.join(dir,'metrics-export.csv'));assert.match(fs.readFileSync(path.join(dir,'metrics-export.csv'),'utf8'),/Primeira conversão no retorno/);
 await page.locator('[data-metrics-filter=from]').fill('2026-10-02');await page.locator('[data-metrics-filter=from]').dispatchEvent('change');await page.evaluate(()=>window.failSpend=true);await page.locator('[data-investment-load]').click();await page.locator('#campaign-investment [role=status]').filter({hasText:'indisponível'}).waitFor();assert.equal(await page.locator('#campaign-investment .metrics-card').count(),0);await page.locator('[data-metrics-filter=from]').fill('');await page.locator('[data-metrics-filter=from]').dispatchEvent('change');
 await page.setViewportSize({width:390,height:844});await page.locator('[data-metrics-tab=overview]').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(dir,'metrics-overview-mobile.png'),fullPage:true});
 await page.goto(base+'/?campaign=1');await page.waitForFunction(()=>window.ready);assert.equal(await page.locator('[data-campaign-report] .metrics-card').nth(1).locator('strong').innerText(),String(expected.scheduled));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.setViewportSize({width:1440,height:1100});
 const row=page.locator('.analytics-table').last().locator('tbody tr').first();await row.locator('[data-analysis-detail]').click();const detail=page.locator('.analytics-detail-row:visible');assert.match(await detail.innerText(),/Atendimento/);await detail.locator('[data-campaign-conversation]').click();assert.equal(await page.evaluate(()=>window.actions.length),1);
 await page.screenshot({path:path.join(dir,'crm-direct-desktop.png'),fullPage:true});
 await page.locator('[data-analysis-view=acquisition]').click();assert.equal(await page.locator('[data-campaign-report] .metrics-card').nth(2).locator('strong').innerText(),String(expected.first_conversion_return));
 await page.locator('[data-campaign-filter=query]').fill('Cirlene');await page.locator('[data-campaign-filter=query]').dispatchEvent('change');assert.match(await page.locator('[data-campaign-report]').innerText(),/Primeira conversão no retorno/);await page.locator('.analytics-table').last().locator('[data-analysis-detail]').last().click();assert.match(await page.locator('.analytics-table').last().innerText(),/Espontâneo \/ orgânico/);
 await page.screenshot({path:path.join(dir,'crm-acquisition-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(dir,'crm-acquisition-mobile.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,sixOverviewCards:true,metricPanels:5,campaignViews:2,scheduled:expected.scheduled,firstConversionReturn:expected.first_conversion_return,desktopAndMobile:true,csv:true}));
 }finally{await browser?.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
