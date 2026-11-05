import {CashConnection} from './connection.mjs';
import {cashError,externalId,bookingInput,availableSlots,minutes,clock,sameQuote} from '../vercel-app/lib/cashbarber-domain.mjs';
import {calendarDate,parseCalendar} from './calendar.mjs';
const origin='https://painel.cashbarber.com.br';
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const weekdays=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const money=s=>{const n=Number(String(s).replace(/[^\d,.-]/g,'').replace(/\./g,'').replace(',','.'));if(!Number.isFinite(n)||n<0)throw cashError('Valor do serviço não reconhecido.',502);return Math.round(n*100);};
const localPhone=value=>{let digits=String(value||'').replace(/\D/g,'');if(digits.startsWith('55')&&[12,13].includes(digits.length))digits=digits.slice(2);return digits;};
const phoneKey=value=>{const digits=localPhone(value);return digits.length===11&&digits[2]==='9'?digits.slice(0,2)+digits.slice(3):digits;};
const displayPhone=digits=>digits.length===11?`(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`:digits.length===10?`(${digits.slice(0,2)}) ${digits.slice(2,6)}-${digits.slice(6)}`:digits;
const customerRows=rows=>rows.filter(row=>/^\d{1,12}$/.test(row.cells[0])&&row.href).map(row=>({id:externalId(row.cells[0]),name:row.cells[1]}));

export class CashBrowser extends CashConnection {
  async perform(tenant,action,input={}){
    const ttl={status:15000,professionals:300000,services:120000,clients:15000,client:15000,'week-day':30000}[action],key=action+':'+JSON.stringify({...input,refresh:undefined});
    if(ttl&&!input.refresh){const hit=this.cached(tenant,key);if(hit)return {...hit,cached:true};}
    if(this.locks.has(tenant))throw cashError('O CashBarber está processando outra consulta. Tente novamente em instantes.',409);
    if(this.locks.size>=3)throw cashError('Conector ocupado. Tente novamente em instantes.',503);
    this.locks.add(tenant);
    try{
      if(['disconnect','login','commit'].includes(action))this.clear(tenant);
      if(action==='disconnect'){await this.contexts.get(tenant)?.close();this.contexts.delete(tenant);await this.vault.remove('session_'+tenant);return {connected:false};}
      const page=await this.page(tenant);
      if(action==='login')return await this.login(tenant,page,input);
      const result=async value=>this.remember(tenant,key,await value,ttl);
      if(action==='status'){if(input.refresh||!page.url().startsWith(origin)||page.url().includes('/auth'))await this.goto(page,'/scheduling',false,!!input.refresh);return await result({connected:!page.url().includes('/auth'),status:page.url().includes('/auth')?'disconnected':'connected'});}
      if(action==='clients')return await result(this.clients(page,input.search).then(clients=>({clients})));
      if(action==='client')return await result(this.client(page,externalId(input.id)).then(client=>({client})));
      if(action==='professionals')return await result(this.professionals(page).then(professionals=>({professionals})));
      if(action==='services'){const professional=await this.professional(page,externalId(input.id));return await result({professional,services:professional.services});}
      if(action==='week-day'){
        const date=calendarDate(input.date),directory=this.cached(tenant,'professionals:{}');
        const professionals=directory?.professionals||await this.professionals(page);
        if(!directory)this.remember(tenant,'professionals:{}',{professionals},300000);
        return await result(this.calendar(page,date).then(data=>parseCalendar(data,date,professionals)));
      }
      if(action==='preview'){
        const details=bookingInput(input),known={client:this.cached(tenant,'client:'+JSON.stringify({id:details.clientId}))?.client,professional:this.cached(tenant,'services:'+JSON.stringify({id:details.professionalId}))?.professional};
        return await this.preview(page,details,false,known);
      }
      if(action==='commit')return await this.commit(tenant,page,input);
      if(action==='reconcile')return await this.reconcile(tenant,page,input);
      throw cashError('Operação inválida.',404);
    }catch(error){
      if(!error.status){await this.contexts.get(tenant)?.close().catch(()=>{});this.contexts.delete(tenant);this.clear(tenant);}
      throw error;
    }finally{if(action==='commit')this.clear(tenant);this.locks.delete(tenant);}
  }
  async table(page,headers){
    const tables=page.getByRole('table');for(let i=0;i<await tables.count();i++){const table=tables.nth(i),text=clean(await table.getByRole('row').first().innerText());if(headers.every(h=>text.toLocaleLowerCase('pt-BR').includes(h.toLocaleLowerCase('pt-BR'))))return table;}
    throw cashError('A tabela do CashBarber não pôde ser identificada: '+headers.join(' / ')+'. Consulta interrompida.',502);
  }
  async tableRows(table){return table.locator('tbody tr').evaluateAll(rows=>rows.map(row=>({cells:[...row.querySelectorAll('td')].map(td=>td.innerText.trim()),href:row.querySelector('a[href*="/edit/"]')?.getAttribute('href')})).filter(row=>row.cells.length));}
  async list(page,path,headers,search){
    await this.goto(page,path);const table=await this.table(page,headers);
    if(search){await page.getByRole('searchbox',{name:'Pesquise...',exact:true}).fill(search);await this.settle(page,500);}
    const result=[];for(let i=0;i<30;i++){await page.waitForTimeout(200);result.push(...await this.tableRows(table));const next=page.getByRole('button',{name:'Next Page',exact:true});if(!await next.count()||!await next.isEnabled())return result;await next.click();await page.waitForTimeout(500);}
    throw cashError('Listagem excede o limite da consulta. Refine a busca.',422);
  }
  async clients(page,search){
    if(typeof search!=='string'||search.length<3||search.length>100)throw cashError('Busca inválida.');
    if(/^[+\d\s().-]+$/.test(search)&&/^\d{10,15}$/.test(search.replace(/\D/g,'')))return this.phoneClients(page,search);
    return customerRows(await this.list(page,'/cliente',['ID','Nome','Opções'],search));
  }
  async phoneClients(page,search){
    // Resolve formatted phone matches from the scheduling selector to IDs in
    // the directory, then verify each phone before presenting the candidates.
    let digits=localPhone(search);if(digits.length===10&&/[6-9]/.test(digits[2]))digits=digits.slice(0,2)+'9'+digits.slice(2);
    await this.goto(page,'/scheduling');await page.getByRole('button',{name:'Novo agendamento',exact:true}).click();const form=page.getByRole('dialog',{name:'Novo agendamento',exact:true});
    await form.getByRole('combobox',{name:'Cliente*',exact:true}).fill(displayPhone(digits));await this.settle(page,600);
    const names=[...new Set((await page.getByRole('option').allTextContents()).map(clean).filter(Boolean))];
    await form.getByRole('button',{name:'Cancelar',exact:true}).click();
    if(names.length>5)throw cashError('Muitos cadastros para este telefone. Busque pelo nome e confira o cadastro.',422);
    const found=new Map(),seen=new Set();let checked=0;
    for(const name of names){for(const candidate of customerRows(await this.list(page,'/cliente',['ID','Nome','Opções'],name))){
      if(seen.has(candidate.id))continue;seen.add(candidate.id);
      if(++checked>10)throw cashError('Muitos cadastros semelhantes. Refine a busca pelo nome.',422);
      const customer=await this.client(page,candidate.id);if(phoneKey(customer.phone)===phoneKey(search))found.set(candidate.id,candidate);
    }}
    return [...found.values()];
  }
  async client(page,id){
    await this.goto(page,'/cliente/edit/'+id,true,true);await page.getByRole('textbox',{name:'Telefone *',exact:true}).waitFor();
    const value=async name=>clean(await page.getByRole('textbox',{name,exact:true}).inputValue());
    const nameInput=page.getByRole('textbox',{name:/^Nome( \*)?$/});
    const planField=page.getByRole('textbox',{name:'Plano ativo do cliente',exact:true});
    const client={id,name:clean(await nameInput.inputValue()),phone:await value('Telefone *'),plan:await planField.count()?clean(await planField.inputValue()):'',history:[]};
    const table=await this.table(page,['ID','Profissional','Realizado em','Status']);
    client.history=(await this.tableRows(table)).filter(r=>/^\d+$/.test(r.cells[0])).map(r=>({id:r.cells[0],professional:r.cells[1],date:r.cells[2],service:r.cells[3],status:r.cells[5]}));return client;
  }
  async professionals(page){return (await this.list(page,'/usuario',['ID','Nome','Tipo','Opções'])).filter(r=>r.cells[4]==='PROFISSIONAL').map(r=>({id:externalId(r.cells[0]),name:r.cells[1]}));}
  async professional(page,id){
    await this.goto(page,'/usuario/edit/'+id,true,true);await page.getByRole('textbox',{name:'Nome no APP *',exact:true}).waitFor();
    const appName=clean(await page.getByRole('textbox',{name:'Nome no APP *',exact:true}).inputValue());
    const fullName=page.getByRole('textbox',{name:'Nome Completo *',exact:true});
    const name=await fullName.count()?clean(await fullName.inputValue()):appName;
    const services=(await this.tableRows(await this.table(page,['Serviço','Comissão','Duração','Valor']))).map(r=>({name:r.cells[1],duration:Number(r.cells[3]?.match(/\d+/)?.[0]),price:money(r.cells[4])}));
    const work=(await this.tableRows(await this.table(page,['Dia semana','Hora Início','Hora fim']))).map(r=>({day:r.cells[0],start:r.cells[1],end:r.cells[2]}));
    const noBreaks=await page.getByRole('heading',{name:'Nenhum intervalo adicionado!',exact:true}).count();
    const breaks=noBreaks?[]:(await this.tableRows(await this.table(page,['Hora início intervalo','Hora fim intervalo']))).map(r=>({day:r.cells[0],start:r.cells[1],end:r.cells[2]}));
    return {id,name,appName,services,work,breaks};
  }
  async calendar(page,date,fresh=false){
    await this.goto(page,'/scheduling',true,fresh);const dateInput=page.locator('input[type="date"]').first();await dateInput.waitFor();
    const changed=await dateInput.inputValue()!==date;
    if(changed){await dateInput.fill(date);await dateInput.press('Tab');}
    await page.getByRole('button',{name:/^\d+ Agendamentos?$/i}).or(page.getByRole('checkbox',{name:/^\d+\s*AGENDAMENTOS?$/i})).first().waitFor({timeout:20000});
    const all=page.getByRole('button',{name:'Todos',exact:true});if(await all.count())await all.click();
    await this.settle(page,changed?500:100);await page.locator('.rbc-time-view').waitFor();
    if(await dateInput.inputValue()!==date)throw cashError('A data exibida na agenda não corresponde à consulta.',502);
    return page.evaluate(()=>{
      const headers=[...document.querySelectorAll('.rbc-time-header-content')].map(e=>e.querySelector('[role="group"]')?.getAttribute('aria-label')?.split(':')[0]?.replace(/\s+/g,' ').trim());
      const columns=[...document.querySelectorAll('.rbc-time-content .rbc-day-slot')].map(col=>[...col.querySelectorAll('.rbc-event')].map(e=>{
        const value=e.innerText.trim(),match=value.match(/(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/);
        return {start:match?.[1]||'',end:match?.[2]||'',kind:/Não atende/i.test(value)?'off':/Bloqueado/i.test(value)?'blocked':'busy'};
      }));
      const times=[...document.querySelectorAll('.rbc-time-gutter .rbc-label')].map(e=>e.textContent.trim()).filter(t=>/^\d{2}:\d{2}$/.test(t));
      return {headers,columns,times};
    });
  }
  async agenda(page,date,professional){
    const data=await this.calendar(page,date,true);
    if(data.headers.length!==data.columns.length||data.headers.filter(n=>n===professional.name).length!==1)throw cashError('Não foi possível identificar a agenda deste profissional nesta data. Confira o CashBarber.',422);
    const events=data.columns[data.headers.indexOf(professional.name)];
    if(events.some(e=>!e.start||!e.end))throw cashError('Um bloqueio da agenda não pôde ser interpretado.',502);
    return events;
  }
  async form(page,details,client,professional){
    await page.getByRole('button',{name:'Novo agendamento',exact:true}).click();const form=page.getByRole('dialog',{name:'Novo agendamento',exact:true});
    await form.getByLabel('Data',{exact:true}).fill(details.date);
    await form.getByLabel('Início',{exact:true}).fill(details.start);
    const customer=form.getByRole('combobox',{name:'Cliente*',exact:true});await customer.fill(client.phone);await page.waitForTimeout(800);
    let matches=page.getByRole('option',{name:client.name,exact:true});
    if(await matches.count()===0){await customer.fill(client.name);await page.waitForTimeout(800);matches=page.getByRole('option',{name:client.name,exact:true});}
    if(await matches.count()!==1)throw cashError('Cliente ambíguo na seleção. Confira telefone e cadastro no CashBarber.',422);
    await matches.click();await form.getByRole('combobox',{name:'Profissional',exact:true}).click();await page.getByRole('option',{name:professional.name,exact:true}).click();
    await form.getByRole('combobox',{name:'Serviço',exact:true}).fill(details.service);await page.getByRole('option',{name:details.service,exact:true}).click();
    await form.getByRole('columnheader',{name:'Valor',exact:true}).waitFor();const table=await this.table(form,['Serviço','Valor','Duração']);await table.locator('tbody tr').first().waitFor();const rows=await this.tableRows(table);
    if(rows.length!==1||rows[0].cells[0]!==details.service)throw cashError('Serviço não reconhecido na conferência.',502);
    const duration=Number(rows[0].cells[2].match(/\d+/)?.[0]);
    if(!Number.isInteger(duration)||duration<1||duration>720||minutes(details.start)+duration>=1440)throw cashError('Duração do serviço não reconhecida.',422);
    // The provider can leave the previous end time after a programmatic change
    // of start. Set both editable time fields from its returned service duration.
    const end=clock(minutes(details.start)+duration);
    await form.getByLabel('Início',{exact:true}).fill(details.start);
    await form.getByLabel('Término',{exact:true}).fill(end);
    await form.getByLabel('Término',{exact:true}).press('Tab');
    await this.settle(page);
    if(await form.getByLabel('Início',{exact:true}).inputValue()!==details.start||await form.getByLabel('Término',{exact:true}).inputValue()!==end||await form.getByLabel('Data',{exact:true}).inputValue()!==details.date)throw cashError('Duração e horário divergentes. Confira o CashBarber.',422);
    return {form,quote:{...details,clientName:client.name,professionalName:professional.name,plan:client.plan,price:money(rows[0].cells[1]),duration,end}};
  }
  async preview(page,details,keepForm=false,known={}){
    // Metadata may be reused briefly for browsing. A commit never supplies
    // known metadata: client, professional, schedule and price are re-read.
    const client=(!keepForm&&known.client)||await this.client(page,details.clientId),professional=(!keepForm&&known.professional)||await this.professional(page,details.professionalId);
    if(professional.services.filter(s=>s.name===details.service).length!==1)throw cashError('Serviço indisponível para o profissional.',422);
    const blocks=await this.agenda(page,details.date,professional),{form,quote}=await this.form(page,details,client,professional);
    const day=weekdays[new Date(details.date+'T12:00:00Z').getUTCDay()],work=professional.work.filter(r=>r.day===day);
    const slots=availableSlots({date:details.date,duration:quote.duration,work,blocks:[...blocks,...professional.breaks.filter(r=>r.day===day)]});
    const available=slots.includes(details.start);if(!keepForm)await form.getByRole('button',{name:'Cancelar',exact:true}).click();
    return {quote,available,slots,checkedAt:Date.now(),...(keepForm?{form,client}:{})};
  }
  async commit(tenant,page,{quote,operation}){
    if(!/^[a-f0-9-]{36}$/i.test(operation||''))throw cashError('Operação inválida.');const key='booking_'+tenant+'_'+operation;
    const saved=await this.vault.read(key);if(saved)return saved.state==='pending'?{state:'uncertain',message:'Tentativa já iniciada. Confira a agenda antes de repetir.'}:saved;
    let current;
    try{current=await this.preview(page,bookingInput(quote),true);}catch(error){return {state:'rejected',message:error.status?error.message:'Não foi possível conferir o horário. Faça uma nova consulta.'};}
    if(!current.available||!sameQuote(current.quote,quote)){await current.form.getByRole('button',{name:'Cancelar',exact:true}).click();return {state:'rejected',message:'Horário, duração ou valor alterado. Faça uma nova consulta.'};}
    const evidence={quote,knownIds:current.client.history.map(h=>h.id),created:Date.now()};
    await this.vault.write(key,{state:'pending',...evidence});
    try{
      await current.form.getByRole('button',{name:'Salvar',exact:true}).click();
      await current.form.waitFor({state:'hidden',timeout:20000});
      const customer=await this.client(page,quote.clientId),known=new Set(current.client.history.map(h=>h.id));
      const [y,m,d]=quote.date.split('-'),date=`${d}/${m}/${y} ${quote.start}`;
      const matching=customer.history.filter(h=>!known.has(h.id)&&h.date===date&&h.professional===quote.professionalName&&h.service===quote.service&&h.status==='Agendado');
      const result=matching.length===1?{state:'confirmed',externalId:matching[0].id,message:'Agendamento confirmado no CashBarber.'}:{state:'uncertain',message:'Envio realizado; não foi possível confirmar o registro. Confira a agenda antes de repetir.'};
      await this.vault.write(key,{...result,...evidence});return result;
    }catch{
      const result={state:'uncertain',message:'Resultado não confirmado. Confira a agenda antes de repetir.'};await this.vault.write(key,{...result,...evidence});return result;
    }
  }
  async reconcile(tenant,page,{operation}){
    if(!/^[a-f0-9-]{36}$/i.test(operation||''))throw cashError('Operação inválida.');const key='booking_'+tenant+'_'+operation;
    const saved=await this.vault.read(key);if(!saved)return {state:'rejected',message:'O conector não iniciou a gravação desta tentativa.'};
    if(saved.state==='confirmed')return {state:'confirmed',externalId:saved.externalId,message:saved.message};
    const customer=await this.client(page,saved.quote.clientId),[y,m,d]=saved.quote.date.split('-');
    const matches=customer.history.filter(h=>!saved.knownIds.includes(h.id)&&h.date===`${d}/${m}/${y} ${saved.quote.start}`&&h.professional===saved.quote.professionalName&&h.service===saved.quote.service&&h.status==='Agendado');
    if(matches.length!==1)return {state:'uncertain',message:'Não foi possível confirmar um registro único. Confira a agenda diretamente no CashBarber.'};
    const result={state:'confirmed',externalId:matches[0].id,message:'Agendamento localizado no CashBarber.'};await this.vault.write(key,{...saved,...result});return result;
  }
}
