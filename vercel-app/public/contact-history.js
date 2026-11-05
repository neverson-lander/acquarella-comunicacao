import {displayContactPhone} from './contact-domain.mjs';
import {bookingDate} from './booking-display.mjs';
import {bookingHistoryMarkup} from './booking-history.mjs';
import {reportedSchedulingMarkup} from './scheduling-form.js';
import {channelNames} from './channel-brand.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={name:'Nome',account:'Canal',phone:'Telefone',email:'E-mail',notes:'Observações',active:'Status do contato',campaign_excluded:'Receber campanhas'};
const empty=v=>v===undefined||v===null||v===''||typeof v==='object'&&Object.keys(v).length===0;
const same=(a,b)=>empty(a)&&empty(b)||JSON.stringify(a)===JSON.stringify(b);
const eventDate=v=>{const date=new Date(Number(v));return !v||!Number.isFinite(date.getTime())?'Horário não informado':date.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})+' às '+date.toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});};
function readable(key,value,meta,field){
 if(empty(value))return 'Não informado';
 if(key==='account'){const a=meta.accounts.find(a=>a.id===value);return a?`${channelNames[a.channel]||'Canal'} · ${a.name}`:'Canal indisponível';}
 if(key==='phone')return displayContactPhone(value);
 if(key==='active')return value?'Ativo':'Desativado';
 if(key==='campaign_excluded')return value?'Não':'Sim';
 if(field?.kind==='date')return bookingDate(value);
 if(typeof value==='boolean')return value?'Sim':'Não';
 if(field?.kind==='number'&&Number.isFinite(Number(value)))return Number(value).toLocaleString('pt-BR');
 if(Array.isArray(value))return value.map(v=>typeof v==='object'?v.name||'Valor indisponível':String(v)).join(', ');
 return typeof value==='object'?'Valor indisponível':String(value);
}
function changes(h,meta){
 const before=h.before_data||{},after=h.after_data||{},created=!h.before_data;
 if(/^Tag /.test(h.action))return [{label:'Tag',before:before.name||null,after:after.name||null,tag:true}];
 const rows=[];
 for(const [key,label]of Object.entries(labels)){
  if(same(before[key],after[key])||created&&empty(after[key]))continue;
  rows.push({label,before:created?null:readable(key,before[key],meta),after:readable(key,after[key],meta),created});
 }
 const oldFields=before.custom_fields||{},newFields=after.custom_fields||{};
 for(const id of new Set([...Object.keys(oldFields),...Object.keys(newFields)])){
  if(same(oldFields[id],newFields[id])||created&&empty(newFields[id]))continue;
  const field=meta.fields.find(f=>f.id===id);
  rows.push({label:field?.name||'Campo personalizado indisponível',before:created?null:readable('',oldFields[id],meta,field),after:readable('',newFields[id],meta,field),created});
 }
 return rows;
}
export function contactHistoryMarkup({contact,history,meta,bookings=[],reported=[],team=[]}){
 const sorted=[...history].sort((a,b)=>Number(b.created)-Number(a.created)),scheduled=[...new Map(bookings.filter(b=>b.confirmed_at).map(b=>[b.id,b])).values()],external=reported.filter(h=>h.scheduling?.services?.some(s=>s.source==='cashbarber_external'));
 const initials=(contact.name||'Contato').trim().split(/\s+/).map(w=>w[0]).filter(Boolean),count=scheduled.length+external.length;
 const timeline=sorted.map(h=>{const rows=changes(h,meta),created=h.action==='Cadastro criado';return `<article class="contact-timeline-event"><span class="contact-timeline-marker ${created?'is-created':''}" aria-hidden="true">${created?'+':'•'}</span><div class="contact-timeline-card"><header><strong>${esc(h.action)}</strong><time>${esc(eventDate(h.created))}</time></header><p class="contact-event-actor">${esc(h.actor_name||'Sistema')}</p>${rows.length?`<dl class="contact-change-list">${rows.map(r=>`<div class="contact-change-row"><dt>${esc(r.label)}</dt><dd>${r.created?`<span class="contact-change-current">${esc(r.after)}</span>`:r.tag?`<span class="contact-history-tag">${esc(r.after||r.before||'Tag indisponível')}</span>`:`<span class="contact-change-before"><small>Antes</small>${esc(r.before)}</span><span class="contact-change-arrow" aria-hidden="true">→</span><span class="contact-change-after"><small>Depois</small>${esc(r.after)}</span>`}</dd></div>`).join('')}</dl>`:'<p class="contact-event-note">Atualização registrada no cadastro.</p>'}</div></article>`;}).join('');
 const emptyAppointments='<div class="contact-history-empty"><span aria-hidden="true">▦</span><strong>Nenhum agendamento no histórico</strong><p>As reservas confirmadas pela central e os serviços informados no encerramento aparecerão aqui.</p></div>';
 return `<div class="contact-history-shell"><div class="contact-history-identity"><span class="contact-history-avatar" aria-hidden="true">${esc(initials[0]||'C')}${esc(initials.length>1?initials.at(-1):'')}</span><div><strong>${esc(contact.name||'Contato')}</strong><small>${esc(contact.phone?displayContactPhone(contact.phone):'Telefone não informado')}</small></div><span class="contact-history-status ${contact.active===false?'is-inactive':''}">${contact.active===false?'Desativado':'Ativo'}</span></div><div class="contact-history-tabs" role="tablist" aria-label="Histórico do contato"><button type="button" role="tab" id="contact-history-tab-changes" data-history-tab="changes" aria-selected="true" aria-controls="contact-history-changes">Alterações <span>${sorted.length}</span></button><button type="button" role="tab" id="contact-history-tab-bookings" data-history-tab="bookings" aria-selected="false" aria-controls="contact-history-bookings" tabindex="-1">Agendamentos <span>${count}</span></button></div><div id="contact-history-changes" class="contact-history-panel" role="tabpanel" aria-labelledby="contact-history-tab-changes"><p class="contact-history-caption">Mais recentes primeiro · Horários de Brasília</p><div class="contact-timeline">${timeline||'<div class="contact-history-empty"><strong>Nenhuma alteração registrada</strong><p>As próximas alterações do cadastro aparecerão aqui.</p></div>'}</div></div><div id="contact-history-bookings" class="contact-history-panel" role="tabpanel" aria-labelledby="contact-history-tab-bookings" hidden>${count?`${scheduled.length?`<section class="contact-booking-group"><h3>Confirmados pela central <span>${scheduled.length}</span></h3>${bookingHistoryMarkup(scheduled,esc,team)}</section>`:''}${external.length?`<section class="contact-booking-group"><h3>Informados no encerramento <span>${external.length}</span></h3>${reportedSchedulingMarkup(external,v=>esc(/^\d{4}-\d{2}-\d{2}$/.test(String(v))?bookingDate(v):v))}</section>`:''}`:emptyAppointments}</div></div>`;
}
export function bindContactHistory(dialog){
 const tabs=[...dialog.querySelectorAll('[data-history-tab]')];
 const select=tab=>{for(const button of tabs){const active=button===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;dialog.querySelector('#'+button.getAttribute('aria-controls')).hidden=!active;}};
 for(const tab of tabs){tab.onclick=()=>select(tab);tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const index=tabs.indexOf(tab),next=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];select(next);next.focus();};}
 dialog.classList.add('contact-history-dialog');dialog.addEventListener('close',()=>dialog.classList.remove('contact-history-dialog'),{once:true});
 dialog.querySelector('.modal-footer .primary').hidden=true;dialog.querySelector('#cancel').textContent='Fechar';dialog.querySelector('#modal-form').onsubmit=e=>e.preventDefault();
}
