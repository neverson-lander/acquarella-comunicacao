export function sourceFields(ads,esc,current={},allowUnknown=false,{locked=false}={}){
  const source=['paid','organic',...(allowUnknown?['unknown']:[])].includes(current.source)?current.source:'';
  locked=locked&&source==='paid'&&!!current.ad_id;
  const availableAds=locked&&!ads.some(a=>a.ad_id===current.ad_id)?[...ads,{ad_id:current.ad_id,ad_name:current.meta_snapshot?.ad_name||current.referral?.headline||'Anúncio identificado automaticamente'}]:ads;
  const choices=[['','Selecione a origem'],['organic','Orgânico'],['paid','Campanha paga'],...(allowUnknown?[['unknown','Não identificada']]:[])];
  return `<label>Origem<select name="source" required ${locked?'disabled data-source-locked':''}>${choices.map(([key,label])=>`<option value="${key}" ${source===key?'selected':''}>${label}</option>`).join('')}</select></label><label data-source-ad ${source==='paid'?'':'hidden'}>Anúncio cadastrado<select name="ad_id" ${source==='paid'&&!locked?'required':'disabled'}><option value="">Selecione um anúncio</option>${availableAds.map(a=>`<option value="${esc(a.ad_id)}" ${source==='paid'&&current.ad_id===a.ad_id?'selected':''}>${esc(a.ad_name||'Anúncio')} · ${esc(a.ad_id)}</option>`).join('')}</select></label>${locked?`<input type="hidden" name="source" value="paid"><input type="hidden" name="ad_id" value="${esc(current.ad_id)}"><p class="field-note">Origem e anúncio identificados automaticamente pela campanha.</p>`:''}`;
}
export function bindSourceFields(root){
  const source=root.querySelector('[name="source"]'),ad=root.querySelector('[name="ad_id"]');
  if(source.hasAttribute('data-source-locked'))return;
  source.onchange=()=>{const paid=source.value==='paid';ad.closest('[data-source-ad]').hidden=!paid;ad.disabled=!paid;ad.required=paid;if(!paid)ad.value='';};
}
