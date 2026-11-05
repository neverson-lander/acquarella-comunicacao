// Exclude the whole conversation, even when the bulk closure predates the
// selected reporting period or the conversation has since been reopened.
export function bulkClosedConversations(crm={},conversations=[]){
  const excluded=new Set();
  const collect=(history,conversation)=>{
    for(const h of history||[])if(/^(Atendimento encerrado em massa|Interação do Instagram encerrada em massa)/.test(h.action||''))excluded.add(h.conversation||conversation);
  };
  collect(crm.attendance_history);
  for(const c of conversations)collect(c.attendance_history,c.id);
  return excluded;
}

export function metricsCrm(crm,conversations=[]){
  const excluded=bulkClosedConversations(crm,conversations);
  return {...crm,opportunities:crm.opportunities.filter(o=>!excluded.has(o.conversation))};
}
