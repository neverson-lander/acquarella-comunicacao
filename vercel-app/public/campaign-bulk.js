import {campaignBulkLabels} from './campaign-reconciliation.mjs';
import {campaignBookingLabels} from './campaign-bookings.js';
export function createCampaignBulkUi({api,modal,connect,canConnect,onReport,esc}){
 return async function open(filters){
  const snapshot=structuredClone(filters),{items,preserved}=await api('cashbarber/campaign-bulk-candidates',{filters:snapshot});
  const day=offset=>new Date(Date.now()+offset*86400000).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
  modal('Consultar agendamentos em massa',`<p><strong>${items.length}</strong> atendimento(s) elegível(is) nos filtros atuais. ${preserved} preservado(s) por já possuir informação ou pertencer a outro canal.</p><p>WhatsApp: busca por telefone. Instagram: busca por telefone ou e-mail cadastrado. Correspondências duplicadas exigem conferência. Os resultados e valores serão salvos na central.</p><div class="form-grid"><label>Data marcada para o serviço: de<input type="date" name="from" required value="${day(-30)}"></label><label>Até<input type="date" name="to" required value="${day(60)}"></label></div><p>Até 93 dias de agenda. Somente reservas criadas após a entrada pela campanha serão consideradas.</p><p data-bulk-progress role="status">Pronto para consultar.</p><div data-bulk-results class="contact-history"></div><button type="button" class="secondary" data-bulk-pause hidden>Parar após o registro atual</button><button type="button" class="secondary" data-bulk-renew hidden>Renovar sessão CashBarber</button>`,async()=>{},'Consulta concluída.');
  const form=document.querySelector('#modal-form'),progress=form.querySelector('[data-bulk-progress]'),results=form.querySelector('[data-bulk-results]'),submit=form.querySelector('.primary'),pause=form.querySelector('[data-bulk-pause]'),renew=form.querySelector('[data-bulk-renew]'),error=form.querySelector('.form-error');
  submit.textContent='Consultar agendamentos em massa';
  let index=0,busy=false,stopped=false,range=null;
  const active=()=>form.isConnected&&form.closest('dialog')?.open!==false;
  const update=()=>{progress.textContent=`${index} de ${items.length} processado(s). ${busy?'Consultando '+items[index]?.client+'…':index===items.length?'Consulta concluída.':'Consulta pausada. Clique em Retomar consulta para continuar.'}`;};
  const settle=()=>{
   form.removeAttribute('aria-busy');pause.hidden=true;submit.disabled=false;
   if(index===items.length){
    renew.hidden=true;submit.textContent='Fechar';submit.type='button';submit.onclick=()=>form.closest('dialog')?.close();
    const cancel=form.querySelector('#cancel');if(cancel)cancel.hidden=true;
    for(const input of form.querySelectorAll('input')){input.disabled=false;input.readOnly=true;}
    update();submit.focus();
   }else{submit.textContent='Retomar consulta';update();}
  };
  if(!items.length){settle();progress.textContent='Nenhum atendimento elegível nos filtros atuais. Nenhuma consulta foi iniciada.';}
  pause.onclick=()=>{stopped=true;pause.disabled=true;};
  renew.onclick=()=>{if(canConnect())connect(async()=>{if(active()){renew.hidden=true;await run();}});};
  async function run(){
   if(busy||!active()||index===items.length)return;busy=true;stopped=false;submit.disabled=true;pause.hidden=false;pause.disabled=false;error.textContent='';form.setAttribute('aria-busy','true');
   for(const input of form.querySelectorAll('input'))input.disabled=true;
   try{while(index<items.length&&active()&&!stopped){
    update();const item=items[index];let report;
    try{report=await api('cashbarber/campaign-bulk-check',{conversation:item.conversation,filters:snapshot,...range});}
    catch(e){
     if([401,403,408,409,429,500,502,503,504].includes(e.status)){
      error.textContent=e.message;const expired=[401,403].includes(e.status)||e.status===409&&/sess|conex|conect|expir/i.test(e.message);renew.hidden=!expired||!canConnect();
      if(expired&&!canConnect())error.textContent+=' Solicite a um administrador ou recepcionista a renovação da sessão.';
      break;
     }
     report={status:'error',matches:[],error:e.message};
    }
    if(report.status!=='skipped'&&report.status!=='error')onReport(item,report);
    if(active()){const article=document.createElement('article');article.className='crm-history';const amount=Number.isSafeInteger(report.total_amount_cents)?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(report.total_amount_cents/100):'Valor não informado';article.innerHTML=`<strong>${esc(item.client)}</strong><span>${esc(campaignBookingLabels[report.status]||campaignBulkLabels[report.status]||report.error||'Consulta inconclusiva')}</span>${report.matches?.length?`<span>${report.matches.length} agendamento(s) · ${esc(amount)}</span>`:''}`;results.append(article);}
    index++;
   }}catch(e){if(active())error.textContent=e.message||'Não foi possível concluir o processamento. Retome a consulta.';}finally{busy=false;if(active())settle();}
  }
  form.onsubmit=async e=>{e.preventDefault();if(busy)return;if(!range){const values=new FormData(form),from=values.get('from'),to=values.get('to'),span=Date.parse(to)-Date.parse(from);if(!Number.isFinite(span)||span<0||span>92*86400000){error.textContent='Escolha um período de até 93 dias.';return;}range={from,to};}await run();};
 };
}
