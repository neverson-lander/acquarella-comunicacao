import {nameOrder} from './cashbarber-sort.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const addDays=(date,days)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const monday=date=>{const day=new Date(date+'T12:00:00Z').getUTCDay();return addDays(date,-((day+6)%7));};
const label=date=>new Date(date+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'short',day:'2-digit',month:'2-digit'});
export function createWeeklyAgenda({call,onPick,canPick}){
  let dialog,version=0,start,filter='',showBusy=false,loading=false,pending=Promise.resolve();const days=new Map(),cache=new Map();
  const $=selector=>dialog?.querySelector(selector);
  function close(){version++;dialog?.close();dialog?.remove();dialog=null;}
  function invalidate(){cache.clear();}
  function render(){
    if(!dialog)return;const dates=Array.from({length:7},(_,i)=>addDays(start,i)),people=new Map();
    for(const data of days.values())for(const p of data.professionals||[])people.set(p.id||p.name,{id:p.id,name:p.name});
    const select=$('[data-week-professional]'),chosen=filter;select.innerHTML='<option value="">Todas as profissionais</option>'+[...people].sort((a,b)=>nameOrder(a[1],b[1])).map(([key,p])=>`<option value="${esc(key)}">${esc(p.name)}</option>`).join('');
    if(chosen&&people.has(chosen))select.value=chosen;
    $('[data-week-period]').textContent=label(start)+' a '+label(dates[6]);
    const times=[...days.values()].filter(d=>d.checkedAt).map(d=>d.checkedAt),ready=days.size,failed=[...days.values()].filter(d=>d.error).length;
    dialog.setAttribute('aria-busy',String(loading));
    $('[data-week-progress]').classList.toggle('is-loading',loading);
    $('[data-week-progress]').textContent=loading?`Consultando ${ready} de 7 dias… Os dias já consultados aparecem abaixo.`:`${ready-failed} de 7 dias consultados${failed?' · '+failed+' com falha':''}${times.length?' · dados consultados a partir de '+new Date(Math.min(...times)).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'}):''}.`;
    dialog.querySelectorAll('[data-week-nav], [data-week-refresh], [data-week-date]').forEach(el=>el.disabled=loading);
    const rows=[...people].filter(([key])=>!filter||key===filter).sort((a,b)=>nameOrder(a[1],b[1]));
    $('[data-week-grid]').innerHTML=`<table><caption>Janelas livres por profissional e dia</caption><thead><tr><th scope="col">Profissional</th>${dates.map(date=>`<th scope="col">${esc(label(date))}</th>`).join('')}</tr></thead><tbody>${rows.map(([key,p])=>`<tr><th scope="row">${esc(p.name)}</th>${dates.map(date=>{
      const data=days.get(date),person=data?.professionals?.find(r=>(r.id||r.name)===key);
      if(!data)return '<td class="cash-week-unknown">Aguardando consulta</td>';
      if(data.error||!person||person.error)return `<td class="cash-week-unknown">${esc(data.error||person?.error||'Não exibida nesta data')}</td>`;
      return `<td>${person.windows.map(w=>`<button type="button" class="cash-week-free" data-week-pick="${esc(p.id)}" data-week-day="${date}" data-week-time="${w.start}" ${loading||!p.id||!canPick()?'disabled':''} aria-label="Usar ${esc(p.name)}, ${date}, ${w.start} até ${w.end}">${w.start}–${w.end}<small>Livre</small></button>`).join('')||'<span class="cash-week-full">Sem janela livre</span>'}${showBusy?person.blocks.map(b=>`<span class="cash-week-block ${b.kind==='off'?'off':''}">${b.start}–${b.end}<small>${b.kind==='off'?'Não atende':b.kind==='blocked'?'Bloqueado':'Ocupado'}</small></span>`).join(''):''}</td>`;
    }).join('')}</tr>`).join('')||`<tr><td colspan="8">${filter?'A profissional selecionada não foi exibida nos dias consultados. Selecione Todas para comparar.':'Carregando profissionais e horários…'}</td></tr>`}</tbody></table>`;
    dialog.querySelectorAll('[data-week-pick]').forEach(button=>button.onclick=()=>{const value={professionalId:button.dataset.weekPick,date:button.dataset.weekDay,start:button.dataset.weekTime};close();onPick(value);});
  }
  async function load(refresh=false){
    const token=++version;loading=true;days.clear();render();await pending.catch(()=>{});
    for(let i=0;i<7;i++){
      if(token!==version||!dialog)return;const date=addDays(start,i),saved=cache.get(date);
      if(!refresh&&saved&&Date.now()-saved.checkedAt<30000){days.set(date,saved);render();continue;}
      try{
        pending=call('week-day',{date,refresh});const result=await pending;
        if(token!==version||!dialog)return;cache.set(date,result);days.set(date,result);
      }catch(error){if(token!==version||!dialog)return;days.set(date,{error:error.message});}
      render();
    }
    if(token===version&&dialog){loading=false;render();}
  }
  function show({date,professionalId=''}){
    close();start=monday(date);filter=professionalId;days.clear();dialog=document.createElement('dialog');dialog.className='cash-week';dialog.setAttribute('aria-label','Grade semanal CashBarber');
    dialog.innerHTML='<header class="cash-week-header"><div><span class="cash-week-eyebrow">Agenda CashBarber</span><h2>Grade semanal</h2><p data-week-period></p></div><button type="button" class="cash-week-close" data-week-close aria-label="Fechar grade semanal" title="Fechar"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="cash-week-body"><div class="cash-week-toolbar"><div class="cash-week-period-control"><span>Semana de</span><div class="cash-week-date-group"><button type="button" class="secondary" data-week-nav="-7" aria-label="Semana anterior"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button><input type="date" data-week-date aria-label="Semana de"><button type="button" class="secondary" data-week-nav="7" aria-label="Próxima semana"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button></div></div><label class="cash-week-field">Profissional<select data-week-professional><option value="">Todas as profissionais</option></select></label><label class="cash-week-toggle"><input type="checkbox" data-week-busy><span>Mostrar ocupados e bloqueios</span></label><button type="button" class="secondary cash-week-refresh" data-week-refresh><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg><span>Atualizar agenda</span></button></div><div class="cash-week-guide"><p><span class="cash-week-dot" aria-hidden="true"></span><strong>Janelas livres</strong> por profissional e dia</p><span>Clique em um horário para preencher o agendamento.</span></div><p class="cash-week-hint" data-week-hint></p><p class="cash-week-progress" role="status" aria-live="polite" data-week-progress></p><div class="cash-week-scroll" data-week-grid tabindex="0" aria-label="Grade de profissionais e dias"></div><p class="cash-week-footnote">A janela precisa comportar a duração do serviço. Confira o horário e o valor antes de confirmar a reserva.</p></div>';
    document.body.append(dialog);dialog.showModal();$('[data-week-date]').value=start;$('[data-week-hint]').textContent=canPick()?'':'Assuma o atendimento e vincule o cliente para usar um horário. Você pode consultar a grade agora.';
    $('[data-week-close]').onclick=close;dialog.oncancel=event=>{event.preventDefault();close();};
    $('[data-week-professional]').onchange=event=>{filter=event.target.value;render();};$('[data-week-busy]').checked=showBusy;$('[data-week-busy]').onchange=event=>{showBusy=event.target.checked;render();};
    dialog.querySelectorAll('[data-week-nav]').forEach(button=>button.onclick=()=>{start=addDays(start,Number(button.dataset.weekNav));$('[data-week-date]').value=start;load();});
    $('[data-week-date]').onchange=event=>{if(!event.target.value)return;start=monday(event.target.value);event.target.value=start;load();};$('[data-week-refresh]').onclick=()=>load(true);load();
  }
  return {show,close,invalidate,idle:()=>pending.catch(()=>{})};
}
