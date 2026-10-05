export function sourceFields(ads,esc,current={},allowUnknown=false){
  const source=['paid','organic',...(allowUnknown?['unknown']:[])].includes(current.source)?current.source:'';
  const choices=[['','Selecione a origem'],['organic','Orgânico'],['paid','Campanha paga'],...(allowUnknown?[['unknown','Não identificada']]:[])];
  return `<label>Origem<select name="source" required>${choices.map(([key,label])=>`<option value="${key}" ${source===key?'selected':''}>${label}</option>`).join('')}</select></label><label>Anúncio cadastrado<select name="ad_id" ${source==='paid'?'required':'disabled'}><option value="">Selecione um anúncio</option>${ads.map(a=>`<option value="${esc(a.ad_id)}" ${source==='paid'&&current.ad_id===a.ad_id?'selected':''}>${esc(a.ad_name||'Anúncio')} · ${esc(a.ad_id)}</option>`).join('')}</select></label>`;
}
export function bindSourceFields(root){
  const source=root.querySelector('[name="source"]'),ad=root.querySelector('[name="ad_id"]');
  source.onchange=()=>{const paid=source.value==='paid';ad.disabled=!paid;ad.required=paid;if(!paid)ad.value='';};
}
