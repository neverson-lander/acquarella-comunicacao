export function messageContent(message,esc){
  let content=`<p>${esc(message.body)}</p>`;
  if(['image','sticker','audio'].includes(message.kind)&&message.media?.id){
    const url='/api/messages/'+encodeURIComponent(message.id)+'/media',key=message.id+':'+message.media.id;
    content=`<div class="message-media" data-media-key="${esc(key)}">${message.kind==='audio'?`<audio controls preload="none" src="${url}" aria-label="Áudio recebido"></audio><a href="${url}?download=1">Baixar áudio</a>`:`<a href="${url}" target="_blank" rel="noopener"><img src="${url}" loading="lazy" alt="${message.kind==='sticker'?'Figurinha recebida':'Imagem recebida'}"></a>`}<p class="media-error" hidden>Não foi possível carregar o anexo. Ele pode ter expirado na Meta. <button type="button" class="secondary" data-media-retry>Tentar novamente</button></p></div>${message.media.caption?`<p>${esc(message.media.caption)}</p>`:''}`;
  }
  const reactions=(message.reactions||[]).map(r=>`<span class="message-reaction" title="Reação do cliente" aria-label="Reação do cliente: ${esc(r.emoji)}">${esc(r.emoji)}</span>`).join('');
  return content+(reactions?`<div class="message-reactions">${reactions}</div>`:'');
}
export function bindMessageMedia(root){
  for(const wrapper of root.querySelectorAll('.message-media')){
    if(wrapper.dataset.bound)continue;wrapper.dataset.bound='true';
    const element=wrapper.querySelector('img,audio'),error=wrapper.querySelector('.media-error');
    element.addEventListener('error',()=>error.hidden=false);
    wrapper.querySelector('[data-media-retry]').onclick=()=>{error.hidden=true;element.src=element.src.split('?')[0]+'?retry='+Date.now();if(element.tagName==='AUDIO')element.load();};
  }
}
