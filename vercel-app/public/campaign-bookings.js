import {bindSearchEnter} from './search-enter.js';
import {campaignBulkLabels} from './campaign-reconciliation.mjs';
import {cashbarberClientSearch} from './cashbarber-search.mjs';
export const campaignBookingLabels={...campaignBulkLabels,matched:'Reserva criada após o contato da campanha',none_in_period:'Nenhuma reserva posterior no período consultado',inconclusive:'Não foi possível confirmar'};
const day=stamp=>new Date(stamp).toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
const dt=stamp=>new Date(stamp).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
export function createCampaignBookingsUi({api,modal,esc,render,connect,canConnect=()=>false,onReport=()=>{}}){
 const reports=new Map();
 const get=row=>{const report=row.cashbarber_check||reports.get(row.conversation);return report?.ad_id===row.ad_id&&report.since===row.campaign_contact?report:null;};
 async function open(row){
  let selected=null,searching=false,version=0,busy=false,completed=false;
  const context=await api('cashbarber/closure',{conversation:row.conversation});
  if(context.link)selected={id:context.link.client_id,name:context.link.client_name};
  const previous=get(row),from=previous?.from||day(row.campaign_contact),to=previous?.to||day(row.campaign_contact+90*86400000);
  modal('Consultar agendamentos da campanha',`<p><strong>${esc(row.client)}</strong> · ${esc(row.campaign_name)}</p><p>Referência: entrada pela campanha em ${esc(dt(row.campaign_contact))}. Conta somente reservas <strong>criadas depois dessa data</strong>, até o momento da consulta. Esta comparação não comprova que a campanha causou o agendamento.</p><label>Buscar cliente no CashBarber<input data-campaign-client-search enterkeyhint="search" value="${esc(cashbarberClientSearch(row.channel,row.phone,row.phone||row.client))}" maxlength="100"></label><button type="button" class="secondary" data-campaign-client-find>Buscar cliente</button><div data-campaign-clients></div><p data-campaign-client-selected role="status"></p><div class="form-grid"><label>Data marcada para o serviço: de<input type="date" name="from" value="${esc(from)}" required></label><label>Até<input type="date" name="to" value="${esc(to)}" required></label></div><p>Consulte até 93 dias de agenda por vez, incluindo datas futuras se necessário. O resultado se limita a esse período e não depende do encerramento do atendimento.</p><div data-campaign-booking-result aria-live="polite"></div>`,async()=>{},'Consulta concluída.');
  const form=document.querySelector('#modal-form'),search=form.querySelector('[data-campaign-client-search]'),find=form.querySelector('[data-campaign-client-find]'),submit=form.querySelector('.primary'),error=form.querySelector('.form-error');
  bindSearchEnter(search,find);
  const renewal=document.createElement('div');renewal.hidden=true;renewal.innerHTML='<p data-campaign-renew-note role="status"></p><button type="button" class="secondary" data-campaign-renew>Renovar sessão CashBarber</button>';error.before(renewal);
  const renewButton=renewal.querySelector('button'),renewNote=renewal.querySelector('p');let retry=null;
  const clearRenewal=()=>{renewal.hidden=true;retry=null;};
  const handleError=(failure,task)=>{
   error.textContent=failure.message;
   if(!([401,403].includes(failure.status)||failure.status===409&&/sess|conex|conect|expir|autentic|permiss/i.test(failure.message)))return;
   retry=task;renewal.hidden=false;const allowed=canConnect()&&typeof connect==='function';renewButton.hidden=!allowed;
   renewNote.textContent=allowed?'Renove a sessão para continuar esta consulta.':'Solicite a um administrador ou recepcionista a renovação da sessão CashBarber.';
  };
  renewButton.onclick=()=>{
   if(!canConnect()||typeof connect!=='function')return;
   connect(async()=>{if(!form.isConnected||form.closest('dialog')?.open===false)return;const task=retry;clearRenewal();error.textContent='';if(task)await task();});
  };
  const cancel=form.querySelector('#cancel'),footer=form.querySelector('.modal-footer');
  const feedback=document.createElement('p');feedback.className='campaign-query-footer';feedback.hidden=true;
  if(footer)footer.prepend(feedback);
  submit.textContent='Consultar';
  const clearResult=()=>{
   form.querySelector('[data-campaign-booking-result]').replaceChildren();completed=false;
   feedback.hidden=true;submit.textContent='Consultar';if(cancel)cancel.textContent='Cancelar';showSelected();
  };
  for(const input of form.querySelectorAll('input[type=date]'))input.onchange=clearResult;
  const showSelected=()=>{form.querySelector('[data-campaign-client-selected]').textContent=selected?'Cliente selecionado: '+selected.name+(completed?'. Consulta concluída. Veja o resultado abaixo.':'. Clique em Consultar para verificar os agendamentos.'):'Selecione o cliente correto no CashBarber.';};showSelected();
  search.oninput=()=>{clearResult();version++;selected=null;form.querySelector('[data-campaign-clients]').replaceChildren();showSelected();};
  find.onclick=async()=>{
   clearResult();const revision=++version;selected=null;showSelected();find.disabled=true;searching=true;error.textContent='';clearRenewal();
   try{const term=search.value.trim();if(term.length<3)throw Error('Digite ao menos três caracteres.');const {clients}=await api('cashbarber/clients',{conversation:row.conversation,search:term});if(!form.isConnected||revision!==version)return;
    const list=form.querySelector('[data-campaign-clients]');list.innerHTML=clients.length?clients.map(c=>`<label class="toggle-row"><span>${esc(c.name)} · #${esc(c.id)}</span><input type="radio" name="cash_client" value="${esc(c.id)}"></label>`).join(''):'<p>Cliente não localizado no CashBarber. Não é possível concluir se houve agendamento.</p>';
    list.onchange=e=>{clearResult();selected=clients.find(c=>String(c.id)===e.target.value);showSelected();};
   }catch(e){if(form.isConnected)handleError(e,()=>find.click());}finally{searching=false;find.disabled=false;}
  };
  form.onsubmit=async e=>{
   e.preventDefault();if(busy)return;error.textContent='';if(searching){error.textContent='Aguarde a busca do cliente.';return;}if(!selected){error.textContent='Selecione o cliente no CashBarber.';return;}
   const values=new FormData(form);clearRenewal();busy=true;completed=false;feedback.hidden=true;showSelected();submit.disabled=true;submit.textContent='Consultando…';find.disabled=true;form.setAttribute('aria-busy','true');for(const control of form.querySelectorAll('input'))control.disabled=true;
   const result=form.querySelector('[data-campaign-booking-result]');result.textContent='Consultando a API do CashBarber…';
   try{const report=await api('cashbarber/campaign-bookings',{conversation:row.conversation,...(row.until!==undefined?{attendance_id:row.id}:{}),client_id:selected.id,from:values.get('from'),to:values.get('to')});reports.set(row.conversation,report);onReport(row,report);render();if(!form.isConnected)return;
    const count=report.matches.length,found=count?`${count} agendamento${count===1?' encontrado':'s encontrados'}.`:report.status==='none_in_period'?'Nenhum agendamento posterior ao contato da campanha encontrado no período.':'Não foi possível confirmar se houve agendamento.';
    const saved=report.saved===true?(report.already_saved?'Resultado já salvo na central; registro anterior preservado.':'Resultado salvo na central.') :report.saved===false?'Resultado não salvo: seu perfil permite apenas consultar.':'Não foi possível confirmar o salvamento. Consulte novamente.';
    result.innerHTML=`<p class="campaign-query-completion ${count?'has-matches':report.status==='none_in_period'?'no-matches':'inconclusive'}" role="status" tabindex="-1" data-campaign-completion><strong>Consulta concluída. ${esc(found)}</strong>${esc(saved)}</p><h3>${esc(campaignBookingLabels[report.status]||campaignBookingLabels.inconclusive)}</h3><p>Cliente: ${esc(report.client_name)} · Agenda de ${esc(report.from)} a ${esc(report.to)} · Consulta: ${esc(dt(report.checked_at))}</p>${report.matches.map(a=>`<article class="crm-history"><strong>Agendamento #${esc(a.id)}</strong><span>Criado em ${esc(dt(a.created_at))}</span><span>Serviço marcado para ${esc(a.date)} às ${esc(a.start)}</span><span>${esc(a.professional)} · ${esc(a.services.join(', '))}</span><span>${Number.isSafeInteger(a.amount_cents)?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(a.amount_cents/100):'Valor não informado'}</span></article>`).join('')}${report.unknown_creation||report.incomplete?'<p>Há registros sem data de criação ou além do limite da consulta. O resultado pode estar incompleto.</p>':''}`;
    completed=true;showSelected();feedback.textContent=count?found:report.status==='none_in_period'?'Consulta concluída · Nenhum agendamento encontrado.':'Consulta concluída · Resultado inconclusivo.';feedback.hidden=false;if(cancel)cancel.textContent='Fechar';
    const completion=result.querySelector('[data-campaign-completion]');completion.focus({preventScroll:true});completion.scrollIntoView({block:'nearest',behavior:'smooth'});
   }catch(e){if(form.isConnected){result.textContent='Consulta não concluída. Salvamento não confirmado.';feedback.textContent='Consulta não concluída. Tente novamente.';feedback.hidden=false;handleError(e,()=>form.requestSubmit());}}finally{busy=false;submit.disabled=false;submit.textContent=completed?'Consultar novamente':'Tentar novamente';find.disabled=false;form.removeAttribute('aria-busy');for(const control of form.querySelectorAll('input'))control.disabled=false;}
  };
 }
 return {get,open};
}
