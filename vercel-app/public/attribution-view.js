import {metaMediaUrl} from './meta-media.js';
export function creativeMarkup(ad,touch,esc){
  const c=ad?.creative||{},r=touch?.referral||{},context=r.ads_context_data||{};
  const image=metaMediaUrl(r.thumbnail_url||r.image_url||context.photo_url||c.thumbnail_url||c.image_url);
  const media=metaMediaUrl(c.permalink||r.video_url||context.video_url||r.source_url||image);
  return `<section class="crm-detail-section"><h3>Criativo associado</h3>${ad?.consulted_at?`<small>Dados consultados: ${esc(new Date(ad.consulted_at).toLocaleString('pt-BR'))}</small>`:''}<dl><dt>ID do criativo</dt><dd>${esc(c.id||'Não informado pela Meta')}</dd><dt>Nome</dt><dd>${esc(c.name||context.ad_title||r.headline||'Não informado')}</dd>${c.video_id?`<dt>ID do vídeo</dt><dd>${esc(c.video_id)}</dd>`:''}</dl>${c.title?`<strong>${esc(c.title)}</strong>`:''}${c.body||r.body?`<p>${esc(c.body||r.body)}</p>`:''}${image?`<img class="crm-creative-image" src="${esc(image)}" alt="Prévia do criativo" referrerpolicy="no-referrer" loading="lazy">`:''}${media?`<a class="crm-media-link" href="${esc(media)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Abrir mídia ↗</a>`:''}${c.dynamic?'<p class="crm-sync-status">Criativo dinâmico: a versão exata exibida ao cliente não é informada neste evento.</p>':''}${ad?.sync_error?`<p class="crm-sync-status">${esc(ad.sync_error)}</p>`:!ad?.verified&&touch?.ad_id?'<p class="crm-sync-status">ID recebido; campanha e criativo aguardam consulta à Meta.</p>':''}</section>`;
}
export function bindCreativeMedia(root){
  root.querySelectorAll('.crm-creative-image').forEach(img=>{img.onerror=()=>{img.hidden=true;};});
}
