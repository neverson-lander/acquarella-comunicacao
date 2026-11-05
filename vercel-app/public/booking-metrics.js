import {bookingServiceDate} from './booking-report.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
const phone=value=>String(value||'').replace(/^55(\d{2})(\d{4,5})(\d{4})$/,'+55 ($1) $2-$3');
const registered=value=>Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Não informado';

export function bookingListMarkup(rows,{page=1,pageSize=10}={}){
  const pages=Math.max(1,Math.ceil(rows.length/pageSize));
  page=Math.max(1,Math.min(page,pages));
  const offset=(page-1)*pageSize;
  const detail=(label,value)=>`<div><dt>${label}</dt><dd>${esc(value||'Não informado')}</dd></div>`;
  return `<div class="booking-list" data-booking-list>
    <div class="booking-list-heading"><div><h3>Clientes e serviços agendados</h3><p>Um serviço por linha. Abra os detalhes para consultar a origem e o registro da reserva.</p></div><span class="booking-count">${rows.length} serviço${rows.length===1?'':'s'}</span></div>
    <div class="crm-table-wrap booking-table-wrap"><table class="booking-table" aria-label="Clientes e serviços agendados">
      <colgroup><col class="booking-col-client"><col class="booking-col-service"><col class="booking-col-date"><col class="booking-col-value"><col class="booking-col-campaign"><col class="booking-col-action"></colgroup>
      <thead><tr>${['Cliente / contato','Serviço / profissional','Data do serviço','Valor na reserva','Campanha / origem','Detalhes'].map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(offset,offset+pageSize).map((r,index)=>{
        const id=`booking-detail-${offset+index}`;
        return `<tr class="booking-main-row">
          <td class="booking-client"><strong>${esc(r.client)}</strong><small>${esc(phone(r.customer))}</small><small>CashBarber ${esc(r.client_id||'—')}</small></td>
          <td class="booking-service"><strong>${esc(r.service||'Serviço não informado')}</strong><small>${esc(r.professional||'Profissional não informado')}</small></td>
          <td class="booking-date" data-label="Data do serviço"><strong>${esc(bookingServiceDate(r.date)||'Não informada')}</strong><small>${esc(r.start)}${r.end?' – '+esc(r.end):''}</small></td>
          <td class="booking-value" data-label="Valor na reserva">${r.price_cents==null?'<span class="booking-unknown">Não informado</span>':`<strong>${money(r.price_cents)}</strong>`}</td>
          <td class="booking-campaign"><span class="booking-source ${r.source==='Campanha paga'?'is-paid':''}">${esc(r.source)}</span><span class="booking-campaign-name">${esc(r.campaign_name)}</span></td>
          <td class="booking-action"><button type="button" class="secondary" data-booking-toggle aria-expanded="false" aria-controls="${id}" aria-label="Ver detalhes de ${esc(r.client)}: ${esc(r.service)}">Detalhes <span aria-hidden="true">＋</span></button></td>
        </tr><tr class="booking-detail-row" id="${id}" hidden><td colspan="6"><dl class="booking-details">
          ${detail('Serviço completo',r.service)}${detail('Campanha',r.campaign_name)}${detail('Anúncio',r.ad_name||r.ad_id||'Sem anúncio')}${detail('Origem identificada',r.source+' · '+r.identification)}${detail('Registrado por',r.actor)}${detail('Confirmação / criação · Brasília',registered(r.confirmed_at))}${detail('Registro CashBarber',r.external_id||r.id)}${detail('Como entrou no histórico',r.queried?'Encontrado em consulta ao CashBarber':'Reserva feita na central')}
        </dl></td></tr>`;
      }).join('')||'<tr><td colspan="6" class="metrics-empty">Nenhum agendamento neste filtro. Ajuste o período ou a busca por cliente, serviço ou campanha.</td></tr>'}</tbody>
    </table></div>
    <div class="booking-pagination"><span role="status">${rows.length?`${offset+1}–${Math.min(offset+pageSize,rows.length)} de ${rows.length} serviços`:'0 serviços'}</span><label>Por página <select data-booking-page-size>${[10,25,50].map(size=>`<option value="${size}" ${size===pageSize?'selected':''}>${size}</option>`).join('')}</select></label><div><button type="button" class="secondary" data-booking-page="${page-1}" ${page===1?'disabled':''} aria-label="Página anterior de agendamentos">Anterior</button><span>Página ${page} de ${pages}</span><button type="button" class="secondary" data-booking-page="${page+1}" ${page===pages?'disabled':''} aria-label="Próxima página de agendamentos">Próxima</button></div></div>
  </div>`;
}

export function bindBookingList(root,rows){
  let pageSize=10;
  function bind(){
    const list=root.querySelector('[data-booking-list]');
    if(!list)return;
    list.querySelectorAll('[data-booking-toggle]').forEach(button=>button.onclick=()=>{
      const expanded=button.getAttribute('aria-expanded')==='true';
      button.setAttribute('aria-expanded',String(!expanded));
      button.querySelector('span').textContent=expanded?'＋':'−';
      list.querySelector('#'+button.getAttribute('aria-controls')).hidden=expanded;
    });
    function update(page,focus){
      list.outerHTML=bookingListMarkup(rows,{page,pageSize});
      bind();
      root.querySelector(focus)?.focus({preventScroll:true});
    }
    list.querySelectorAll('[data-booking-page]').forEach(button=>button.onclick=()=>update(Number(button.dataset.bookingPage),'[data-booking-list] [data-booking-toggle], [data-booking-page-size]'));
    list.querySelector('[data-booking-page-size]').onchange=event=>{pageSize=Number(event.target.value);update(1,'[data-booking-page-size]');};
  }
  bind();
}
