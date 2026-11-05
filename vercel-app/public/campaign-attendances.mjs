import {hasSchedulingInformation} from './campaign-reconciliation.mjs';
import {campaignBookingLabels} from './campaign-bookings.js';
import {realOpportunity,selectedTouch,attendanceStart} from './crm-domain.mjs';
export const outcomeNames={scheduled:'Com agendamento',not_scheduled:'Sem agendamento',information:'Dúvidas / Informações',pending:'Em aberto, sem confirmação',unknown:'Encerrado sem informação'};
export function campaignAttendances(crm,filters={},now=Date.now()){
  const rows=[],query=(filters.query||'').trim().toLocaleLowerCase('pt-BR');
  const from=filters.from?Date.parse(filters.from+'T00:00:00-03:00'):0,to=filters.to?Date.parse(filters.to+'T23:59:59.999-03:00'):now;
  for(const o of crm.opportunities){
    const touches=crm.touches.filter(t=>t.opportunity===o.id&&t.created<=now),started=attendanceStart(touches)||o.first_contact;
    if(!realOpportunity(o)||started<from||started>to||filters.channel&&o.account!==filters.channel||filters.owner&&o.owner!==filters.owner)continue;
    const touch=selectedTouch({touches});
    if(touch.source!=='paid'||!touch.ad_id)continue;
    const ad={...crm.ads.find(a=>a.ad_id===touch.ad_id),...touch.meta_snapshot},campaign=ad.campaign_id||'ad:'+touch.ad_id;
    const contact=crm.contacts.find(c=>c.id===o.contact);
    const history=(crm.attendance_history||[]).filter(h=>h.conversation===o.conversation&&h.created<=now).sort((a,b)=>b.created-a.created||String(b.id).localeCompare(String(a.id)));
    const closure=history.find(h=>h.action==='Atendimento finalizado'||h.action.startsWith('Atendimento encerrado em massa')||h.action.startsWith('Canal excluído:'));
    const bookings=(crm.bookings||[]).filter(b=>b.conversation===o.conversation&&(o.status==='open'?!b.closure_id:b.closure_id===closure?.id));
    const reference=touch.evidence==='webhook'?Number(touch.created)||started:started;
    const stored=(crm.campaign_checks||[]).find(c=>c.conversation===o.conversation&&c.ad_id===touch.ad_id&&c.report?.since===reference)?.report;
    const services=[...(o.status==='resolved'?closure?.scheduling?.services||[]:[])];
    for(const b of bookings)if(!services.some(s=>s.booking_id===b.id))services.push({name:b.quote.service,booking_id:b.id,price_cents:b.quote.price,date:b.quote.date,start:b.quote.start});
    for(const match of stored?.matches||[])for(const service of match.service_details||match.services.map(name=>({name,price_cents:null})))services.push({name:service.name,professional:match.professional,price_cents:service.price_cents,external_appointment_id:match.id,date:match.date,start:match.start});
    const outcome=services.length||o.status==='resolved'&&closure?.scheduling?.had_scheduling===true?'scheduled':o.status==='open'?'pending':closure?.scheduling?.outcome==='information'?'information':closure?.scheduling?.had_scheduling===false?'not_scheduled':'unknown';
    const row={cashbarber_check:stored,has_scheduling_information:hasSchedulingInformation(crm,o.conversation),id:o.id,conversation:o.conversation,client:contact?.name||o.customer_name||o.customer,phone:contact?.phone||o.customer,email:contact?.email||'',account:o.account,channel:o.channel,owner:o.owner,owner_name:o.owner_name||crm.team.find(u=>u.id===o.owner)?.name||'Sem responsável',status:o.status,outcome,services,interest:crm.catalog.find(s=>s.id===o.service)?.name||'',campaign,campaign_name:ad.campaign_name||ad.campaign_id||'Campanha não identificada',ad_id:touch.ad_id,ad_name:ad.ad_name||touch.ad_id,identification:touch.evidence==='manual'?'Manual':touch.evidence==='webhook'?'Automática':'Histórico',first_contact:started,campaign_contact:touch.evidence==='webhook'?Number(touch.created)||started:started,closed_at:o.status==='resolved'?closure?.created||null:null};
    if(filters.campaign&&campaign!==filters.campaign||filters.ad&&touch.ad_id!==filters.ad||filters.outcome&&outcome!==filters.outcome||filters.status&&o.status!==filters.status)continue;
    if(query&&!`${row.client} ${row.phone} ${row.email} ${row.campaign_name} ${row.ad_name} ${row.interest} ${services.map(s=>s.name).join(' ')}`.toLocaleLowerCase('pt-BR').includes(query))continue;
    rows.push(row);
  }
  rows.sort((a,b)=>b.first_contact-a.first_contact||a.id.localeCompare(b.id));
  return {rows,counts:Object.fromEntries(Object.keys(outcomeNames).map(k=>[k,rows.filter(r=>r.outcome===k).length]))};
}
export function campaignAttendancesCsv(rows){
  const data=[['Cliente','Telefone / contato','E-mail','Canal','Campanha','Anúncio','ID anúncio','Identificação','Responsável','Atendimento','Agendamento','Serviços agendados','Serviço de interesse','Data do atendimento','Encerramento','Consulta CashBarber','Agenda consultada de','Agenda consultada até','Consultado em','IDs reservas posteriores','Criação das reservas','Valor dos agendamentos CashBarber'],...rows.map(r=>[r.client,r.phone,r.email,r.channel,r.campaign_name,r.ad_name,r.ad_id,r.identification,r.owner_name,r.status==='open'?'Em aberto':'Encerrado',outcomeNames[r.outcome],r.services.map(s=>s.name).join(' | '),r.interest,new Date(r.first_contact).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),r.closed_at?new Date(r.closed_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'',r.cashbarber_check?campaignBookingLabels[r.cashbarber_check.status]:'Ainda não consultado',r.cashbarber_check?.from||'',r.cashbarber_check?.to||'',r.cashbarber_check?new Date(r.cashbarber_check.checked_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'',r.cashbarber_check?.matches.map(a=>a.id).join(' | ')||'',r.cashbarber_check?.matches.map(a=>new Date(a.created_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})).join(' | ')||'',Number.isSafeInteger(r.cashbarber_check?.total_amount_cents)?(r.cashbarber_check.total_amount_cents/100).toFixed(2):''])];
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\ufeff'+data.map(r=>r.map(cell).join(';')).join('\r\n');
}
