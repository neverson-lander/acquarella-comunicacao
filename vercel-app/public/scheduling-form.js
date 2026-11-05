import {externalSchedulingFields,bindExternalScheduling} from './external-scheduling-form.js';
const money=cents=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);
export function schedulingFields(catalog,esc,bookings=[],options={}){
  const services=catalog.filter(s=>s.kind==='service'&&s.active);
  const confirmed=bookings.length>0;
  if(!confirmed)return '<label>Houve agendamento de serviços?<select name="had_scheduling" required><option value="">Selecione uma resposta</option><option value="yes">Sim</option><option value="no">Não</option><option value="information">Dúvidas / Informações</option></select></label>'+externalSchedulingFields(esc,options.link,options.search);
  return `${confirmed?`<section data-booked-services><h3>Serviços agendados no CashBarber</h3><p>Valores registrados no momento da reserva. Alterações de preço posteriores não modificam este histórico.</p><ul>${bookings.map(b=>`<li><input type="hidden" name="cash_booking_ids" value="${esc(b.id)}"><strong>${esc(b.quote.service)} · ${money(b.quote.price)}</strong><br>${esc(b.quote.clientName)} · ${esc(b.quote.professionalName)}<br>${esc(b.quote.date)} às ${esc(b.quote.start)}</li>`).join('')}</ul><strong>Total agendado: ${money(bookings.reduce((sum,b)=>sum+b.quote.price,0))}</strong></section>`:''}<label>Houve agendamento de serviços?<select name="had_scheduling" required>${confirmed?'<option value="yes" selected>Sim — serviços confirmados no CashBarber</option>':'<option value="">Selecione uma resposta</option><option value="yes">Sim</option><option value="no">Não</option><option value="information">Dúvidas / Informações</option>'}</select></label><div data-scheduled-services ${confirmed?'':'hidden'}><label>${confirmed?'Outros serviços informados manualmente (opcional)':'Serviços agendados'}<select name="scheduled_services" multiple size="${Math.min(6,Math.max(3,services.length))}" ${confirmed?'':'disabled'} aria-describedby="scheduled-services-help" data-has-bookings="${confirmed}">${services.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><small id="scheduled-services-help">${confirmed?'Os serviços confirmados acima já estão incluídos. Selecione aqui somente serviços adicionais.':services.length?'Selecione um ou mais serviços. Para selecionar vários, use Ctrl (ou Command) ao clicar.':'Nenhum serviço ativo cadastrado. Solicite ao administrador o cadastro em CRM > Serviços.'}</small></div>`;
}
export function bindSchedulingFields(root,options={}){
  if(root.querySelector('[data-external-scheduling]')){const external=bindExternalScheduling(root,options),answer=root.querySelector('[name="had_scheduling"]'),section=root.querySelector('[data-external-scheduling]');answer.onchange=()=>{const yes=answer.value==='yes';section.hidden=!yes;section.disabled=!yes;for(const input of section.querySelectorAll('input,select,button'))input.disabled=!yes;if(yes)external.start();};answer.onchange();return {handleConnectionError:error=>external.connectionError(error),readExternalScheduling:()=>answer.value==='yes'?external.read():null};}
  const answer=root.querySelector('[name="had_scheduling"]'),list=root.querySelector('[name="scheduled_services"]'),section=root.querySelector('[data-scheduled-services]');
  answer.onchange=()=>{
    const yes=answer.value==='yes';section.hidden=!yes;list.disabled=!yes;list.required=yes&&list.dataset.hasBookings!=='true';
    if(!yes)for(const option of list.options)option.selected=false;
  };answer.onchange();return {readExternalScheduling:()=>null,handleConnectionError:()=>{}};
}
export function schedulingHistory(scheduling,esc){
  if(!scheduling)return '';
  return `<span>Houve agendamento de serviços: ${scheduling.outcome==='information'?'Dúvidas / Informações':scheduling.had_scheduling?'Sim':'Não'}</span>${scheduling.had_scheduling?`<span>Serviços agendados: ${scheduling.services.map(s=>esc(s.name)+(s.professional?' · '+esc(s.professional):'')+(s.external_appointment_id?' · Agendamento #'+esc(s.external_appointment_id)+' · '+esc(s.date)+' às '+esc(s.start):'')+(Number.isSafeInteger(s.price_cents)?' · '+money(s.price_cents):'')).join(', ')}</span>${scheduling.external_client?'<span>Agendamento informado no encerramento · '+(scheduling.external_client.not_found?'Cliente não localizado no CashBarber':esc(scheduling.external_client.name))+'</span>':''}`:''}`;
}

export function reportedSchedulingMarkup(history,esc){
 const rows=(history||[]).filter(h=>h.scheduling?.services?.some(s=>s.source==='cashbarber_external')).sort((a,b)=>b.created-a.created);
 return rows.length?rows.map(h=>'<article class="crm-history"><strong>Agendamento informado no encerramento</strong><small>'+esc(h.actor_name)+' · '+esc(new Date(Number(h.created)).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}))+'</small>'+schedulingHistory(h.scheduling,esc)+'</article>').join(''):'<p>Nenhum agendamento externo informado.</p>';
}
