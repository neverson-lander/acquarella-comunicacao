import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {CashBrowser} from '../browser.mjs';

test('professional agenda uses full name rather than APP nickname and accepts an explicitly empty break section',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<label>Nome Completo *<input value="Priscila Marques Couto"></label><label>Nome no APP *<input value="Priscila"></label><table><thead><tr><th></th><th>Serviço</th><th>Comissão</th><th>Duração</th><th>Valor</th></tr></thead><tbody><tr><td></td><td>Escova</td><td>50%</td><td>50 min</td><td>R$ 45,00</td></tr></tbody></table><table><thead><tr><th>Dia semana</th><th>Hora Início</th><th>Hora fim</th></tr></thead><tbody><tr><td>Terça</td><td>13:00</td><td>18:00</td></tr></tbody></table><h3>Nenhum intervalo adicionado!</h3>');
  const cash=new CashBrowser(browser,null);cash.goto=async()=>{};const p=await cash.professional(page,'22797');
  assert.equal(p.name,'Priscila Marques Couto');assert.equal(p.appName,'Priscila');assert.deepEqual(p.breaks,[]);assert.equal(p.services[0].price,4500);
  cash.calendar=async()=>({headers:['Outra profissional','Priscila Marques Couto'],columns:[[],[{start:'14:00',end:'14:50',kind:'busy'}]]});
  assert.deepEqual(await cash.agenda(page,'2026-10-20',p),[{start:'14:00',end:'14:50',kind:'busy'}]);
  cash.calendar=async()=>({headers:['Priscila Marques Couto','Priscila Marques Couto'],columns:[[],[]]});await assert.rejects(cash.agenda(page,'2026-10-20',p),e=>e.status===422);
 }finally{await browser.close();}
});

test('real browser: CSS uppercase headers in the scheduling dialog remain readable beside history',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<style>th{text-transform:uppercase}</style><section role="dialog" aria-label="Novo agendamento"><table><thead><tr><th>Serviço</th><th>Valor</th><th>Duração</th><th>Ação</th></tr></thead><tbody><tr><td>Manicure Tradicional</td><td>R$ 0,00</td><td>50 min</td><td>Remover serviço</td></tr></tbody></table><table><thead><tr><th>Data</th><th>Serviços</th><th>Produtos</th><th>Profissional</th></tr></thead><tbody><tr><td>20/10/2026</td><td>Outro serviço</td><td>-</td><td>Isaura</td></tr></tbody></table></section>');
  assert.match(await page.getByRole('table').first().getByRole('row').first().innerText(),/SERVIÇO/);
  const cash=new CashBrowser(browser,null),table=await cash.table(page.getByRole('dialog'),['Serviço','Valor','Duração']);
  const rows=await cash.tableRows(table);assert.equal(rows.length,1);assert.deepEqual(rows[0].cells.slice(0,3),['Manicure Tradicional','R$ 0,00','50 min']);
  await assert.rejects(cash.table(page,['Coluna desconhecida']),error=>error.status===502);
 }finally{await browser.close();}
});

test('quote uses provider duration to replace a stale end time and verifies editable fields',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<style>th{text-transform:uppercase}</style><button id="new">Novo agendamento</button><dialog aria-label="Novo agendamento"><label>Data<input type="date" value="2026-10-19"></label><label>Início<input type="time" value="16:00"></label><label>Término<input type="time" value="16:10"></label><input role="combobox" aria-label="Cliente*" id="client"><div role="option" id="client-option" hidden>Cliente de teste</div><button role="combobox" aria-label="Profissional" id="professional">Selecione</button><div role="option" id="professional-option" hidden>Isaura</div><input role="combobox" aria-label="Serviço" id="service"><div role="option" id="service-option" hidden>Manicure Tradicional</div><div id="items"></div></dialog><script>
   const dialog=document.querySelector('dialog');document.querySelector('#new').onclick=()=>dialog.showModal();
   document.querySelector('#client').oninput=()=>document.querySelector('#client-option').hidden=false;
   document.querySelector('#client-option').onclick=event=>{document.querySelector('#client').value='Cliente de teste';event.target.hidden=true;};
   document.querySelector('#professional').onclick=()=>document.querySelector('#professional-option').hidden=false;
   document.querySelector('#professional-option').onclick=event=>{document.querySelector('#professional').textContent='Isaura';event.target.hidden=true;};
   document.querySelector('#service').oninput=()=>document.querySelector('#service-option').hidden=false;
   document.querySelector('#service-option').onclick=event=>{event.target.hidden=true;document.querySelector('#items').innerHTML='<table><thead><tr><th>Serviço</th><th>Valor</th><th>Duração</th></tr></thead><tbody><tr><td>Manicure Tradicional</td><td>R$ 0,00</td><td>50 min</td></tr></tbody></table>';};
  </script>`);
  const cash=new CashBrowser(browser,null),details={clientId:'1',professionalId:'2',service:'Manicure Tradicional',date:'2026-10-20',start:'14:00'};
  const result=await cash.form(page,details,{name:'Cliente de teste',phone:'(34) 99999-9999',plan:'Plano'},{name:'Isaura'});
  assert.equal(result.quote.start,'14:00');assert.equal(result.quote.end,'14:50');assert.equal(result.quote.duration,50);assert.equal(result.quote.price,0);assert.equal(await page.getByLabel('Término',{exact:true}).inputValue(),'14:50');
 }finally{await browser.close();}
});

test('phone search resolves selector names to IDs, verifies phone and ignores empty directory rows',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(`<button id="new">Novo agendamento</button><dialog aria-label="Novo agendamento"><input role="combobox" aria-label="Cliente*"><div role="listbox"><div role="option">Cliente de teste</div></div><button id="cancel">Cancelar</button></dialog><script>document.querySelector('#new').onclick=()=>document.querySelector('dialog').showModal();document.querySelector('#cancel').onclick=()=>document.querySelector('dialog').close();</script>`);
  const cash=new CashBrowser(browser,null);cash.goto=async()=>{};cash.list=async()=>[{cells:['Nenhum registro encontrado'],href:undefined}];assert.deepEqual(await cash.clients(page,'Não existe'),[]);
  cash.list=async()=>[{cells:['1','Cliente de teste'],href:'/cliente/edit/1'},{cells:['2','Cliente de teste'],href:'/cliente/edit/2'}];
  cash.client=async(_page,id)=>({id,phone:id==='1'?'(34) 99999-9999':'(11) 98888-8888'});
  assert.deepEqual(await cash.clients(page,'+55 34 99999-9999'),[{id:'1',name:'Cliente de teste'}]);
  assert.equal(await page.locator('[aria-label="Cliente*"]').inputValue(),'(34) 99999-9999');
  assert.deepEqual(await cash.clients(page,'553499999999'),[{id:'1',name:'Cliente de teste'}]);
  assert.equal(await page.getByRole('dialog').count(),0);
 }finally{await browser.close();}
});

test('customer without subscription or history has optional plan and no placeholder appointments',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<label>Nome *<input value="Cliente avulso"></label><label>Telefone *<input value="(34) 99999-9999"></label><h3>Histórico</h3><table><thead><tr><th>ID</th><th>Profissional</th><th>Realizado em</th><th>Serviços</th><th>Produtos</th><th>Status</th></tr></thead><tbody><tr><td colspan="6">Nenhum registro encontrado</td></tr></tbody></table>');
  const cash=new CashBrowser(browser,null);cash.goto=async()=>{};
  const customer=await cash.client(page,'1');assert.equal(customer.name,'Cliente avulso');assert.equal(customer.plan,'');assert.deepEqual(customer.history,[]);
 }finally{await browser.close();}
});
