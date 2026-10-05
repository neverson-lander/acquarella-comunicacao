export function schedulingFields(catalog,esc){
  const services=catalog.filter(s=>s.kind==='service'&&s.active);
  return `<label>Houve agendamento de serviços?<select name="had_scheduling" required><option value="">Selecione uma resposta</option><option value="yes">Sim</option><option value="no">Não</option></select></label><div data-scheduled-services hidden><label>Serviços agendados<select name="scheduled_services" multiple size="${Math.min(6,Math.max(3,services.length))}" disabled aria-describedby="scheduled-services-help">${services.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><small id="scheduled-services-help">${services.length?'Selecione um ou mais serviços. Para selecionar vários, use Ctrl (ou Command) ao clicar.':'Nenhum serviço ativo cadastrado. Solicite ao administrador o cadastro em CRM > Serviços.'}</small></div>`;
}
export function bindSchedulingFields(root){
  const answer=root.querySelector('[name="had_scheduling"]'),list=root.querySelector('[name="scheduled_services"]'),section=root.querySelector('[data-scheduled-services]');
  answer.onchange=()=>{
    const yes=answer.value==='yes';section.hidden=!yes;list.disabled=!yes;list.required=yes;
    if(!yes)for(const option of list.options)option.selected=false;
  };
}
export function schedulingHistory(scheduling,esc){
  if(!scheduling)return '';
  return `<span>Houve agendamento de serviços: ${scheduling.had_scheduling?'Sim':'Não'}</span>${scheduling.had_scheduling?`<span>Serviços agendados: ${scheduling.services.map(s=>esc(s.name)).join(', ')}</span>`:''}`;
}
