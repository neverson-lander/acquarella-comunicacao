import {attendanceStart} from './crm-domain.mjs';
export function hasSchedulingInformation(crm,conversation){
 const opportunity=crm.opportunities?.find(o=>o.conversation===conversation);
 const since=attendanceStart((crm.touches||[]).filter(t=>t.opportunity===opportunity?.id));
 return (crm.attendance_history||[]).some(h=>h.conversation===conversation&&h.created>=since&&typeof h.scheduling?.had_scheduling==='boolean')
  ||(crm.bookings||[]).some(b=>b.conversation===conversation&&(!since||b.confirmed_at>=since))
  ||(crm.events||[]).some(e=>e.opportunity===opportunity?.id&&e.kind==='appointment'&&!e.voided&&(!since||e.occurred>=since))
  ||(crm.campaign_checks||[]).some(c=>c.conversation===conversation&&c.report?.status==='matched'&&(!since||c.report.since>=since));
}
export const campaignBulkLabels={client_not_found:'Cliente não localizado',missing_contact:'Sem telefone ou e-mail para buscar',ambiguous_client:'Mais de um cadastro corresponde ao contato',skipped:'Preservado: já possui informação de agendamento'};
