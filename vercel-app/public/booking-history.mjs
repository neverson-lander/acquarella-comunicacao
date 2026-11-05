import {bookingDate} from './booking-display.mjs';
const money=v=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v/100);
const date=v=>v?new Date(Number(v)).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Não informado';
export function bookingHistoryMarkup(bookings,esc,team=[]){
  const rows=[...new Map((bookings||[]).filter(b=>b.confirmed_at).map(b=>[b.id,b])).values()].sort((a,b)=>b.confirmed_at-a.confirmed_at);
  return rows.length?rows.map(b=>{const q=b.quote||{};return `<article class="crm-history"><strong>Agendamento confirmado no CashBarber · ${esc(q.service)}</strong><span>${esc(q.clientName)} · ${esc(q.professionalName)}</span><span>${esc(bookingDate(q.date))} às ${esc(q.start)}${q.end?'–'+esc(q.end):''}${Number.isSafeInteger(q.price)?' · '+money(q.price):''}</span><small>Confirmado em ${date(b.confirmed_at)} · ${esc(team.find(u=>u.id===b.actor)?.name||'Operador não identificado')}</small><small>Registro CashBarber: ${esc(b.receipt?.externalId||'Não informado')}</small></article>`;}).join(''):'<p>Nenhum agendamento confirmado pela central.</p>';
}
export function attendanceTimeline(history,bookings,team=[]){
  const entries=(history||[]).map(h=>({...h}));
  for(const b of new Map((bookings||[]).filter(b=>b.confirmed_at).map(b=>[b.id,b])).values())entries.push({id:'booking:'+b.id,created:b.confirmed_at,actor:b.actor,actor_name:team.find(u=>u.id===b.actor)?.name||'Operador não identificado',action:'Agendamento confirmado no CashBarber',booking:b});
  return entries.sort((a,b)=>b.created-a.created||String(a.id).localeCompare(String(b.id)));
}
