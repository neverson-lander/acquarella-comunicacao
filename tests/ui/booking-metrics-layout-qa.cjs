const {chromium}=require('../../cashbarber-bridge/node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve('vercel-app/public');
const rows=Array.from({length:27},(_,i)=>({id:'b'+i,client:i?'Maria Cristina de Sousa Reis':'<img src=x onerror=alert(1)>',customer:'553484354665',client_id:'3415234',service:i%2?'Pedicure Tradicional - Avulso NÃO É VÁLIDO PARA CLIENTES DE ASSINATURA - Profissional não atende assinantes':'Escova+Hidratação Promocional',professional:'Priscila Marques Couto',date:'2026-10-24',start:'15:00',end:'16:00',price_cents:i===1?null:i===2?0:6700,campaign_name:'CMP - ESCOVAHIDRATACAO - CBO - 10/2026 '+('Campanha longa '.repeat(8)),source:'Campanha paga',identification:'Automática',ad_name:'IMAGEM03 - PROMO/ESCOVA/HIDRATACAO - CONTATO',actor:'Encontrado no CashBarber',queried:true,confirmed_at:1792771200000,external_id:String(4900000+i)}));
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){
    res.setHeader('content-type','text/html; charset=utf-8');
    return res.end(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/crm.css"><link rel="stylesheet" href="/metrics.css"><body style="padding:20px"><section class="metrics-section" id="report"></section><script type="module">import {bookingListMarkup,bindBookingList} from '/booking-metrics.js';const rows=${JSON.stringify(rows).replaceAll('<','\\u003c')};const root=document.querySelector('#report');root.innerHTML=bookingListMarkup(rows);bindBookingList(root,rows);</script></body></html>`);
  }
  const file=path.resolve(root,'.'+url.pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.statusCode=404;return res.end();}
  res.setHeader('content-type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.locator('.booking-main-row').first().waitFor();
    assert.equal(await page.locator('.booking-main-row').count(),10);
    assert.equal(await page.locator('.booking-client img').count(),0);
    assert.equal(await page.locator('.booking-value').nth(1).innerText(),'Não informado');
    assert.match(await page.locator('.booking-value').nth(2).innerText(),/R\$\s*0,00/);
    const checkWidth=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Page must not overflow horizontally');
    const checkCells=async()=>assert.equal(await page.locator('.booking-main-row td').evaluateAll(cells=>cells.every(cell=>cell.scrollWidth<=cell.clientWidth+1)),true,'Cell content must stay in its column');
    await checkWidth();await checkCells();
    const button=page.locator('[data-booking-toggle]').first();
    await button.focus();await page.keyboard.press('Enter');
    await page.locator('#booking-detail-0').waitFor({state:'visible'});
    assert.equal(await button.getAttribute('aria-expanded'),'true');
    assert.match(await page.locator('#booking-detail-0').innerText(),/IMAGEM03/);
    await page.keyboard.press('Enter');assert.equal(await page.locator('#booking-detail-0').isVisible(),false);
    await page.getByRole('button',{name:'Próxima página de agendamentos'}).click();
    assert.match(await page.locator('.booking-pagination').innerText(),/11–20 de 27/);
    await page.getByRole('button',{name:'Próxima página de agendamentos'}).click();
    assert.equal(await page.locator('.booking-main-row').count(),7);
    assert.equal(await page.getByRole('button',{name:'Próxima página de agendamentos'}).isDisabled(),true);
    await page.locator('[data-booking-page-size]').selectOption('25');
    assert.equal(await page.locator('.booking-main-row').count(),25);
    assert.match(await page.locator('.booking-pagination').innerText(),/1–25 de 27/);
    await page.locator('[data-booking-page-size]').selectOption('10');
    for(const width of [1024,768,760,390,320]){
      await page.setViewportSize({width,height:1080});await checkWidth();await checkCells();
      await page.locator('[data-booking-toggle]').nth(1).click();
      assert.match(await page.locator('#booking-detail-1').innerText(),/Profissional não atende assinantes/);
      await checkWidth();await page.locator('[data-booking-toggle]').nth(1).click();
    }
    const out=path.resolve('artifacts/booking-metrics');fs.mkdirSync(out,{recursive:true});
    await page.setViewportSize({width:1440,height:1080});await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:1080});await page.screenshot({path:path.join(out,'mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,pagination:true,keyboardDetails:true,escapedLabels:true,zeroAndUnknownPrices:true,responsiveWidths:[1440,1024,768,760,390,320],screenshots:out}));
  }finally{await browser?.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
