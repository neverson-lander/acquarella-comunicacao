import {uiIcon,fileSize} from './message-icons.js';
export function messageContent(message,esc){
  const labels={image:'Imagem',sticker:'Figurinha',audio:'Áudio',video:'Vídeo',file:'Arquivo',document:'Documento'};
  let content='<p>'+esc(message.body)+'</p>';
  if(['deleted','unsupported'].includes(message.kind))return '<div class="message-notice">'+uiIcon('info')+'<span>'+esc(message.kind==='deleted'?'Mensagem excluída no canal de origem.':'Este conteúdo nativo não foi disponibilizado pela Meta. Visualize no canal de origem.')+'</span></div>';
  const items=message.media?.items||((message.media?.attachmentId||message.media?.qrId||message.media?.id)&&labels[message.kind]?[{kind:message.kind,name:message.media.name}]:[]);
  if(items.length){
    content=items.map((item,index)=>{
      const base='/api/messages/'+encodeURIComponent(message.id)+'/media',query=message.media?.items?'?attachment='+index:'',url=base+query,join=query?'&':'?',kind=item.kind,label=esc(item.name||labels[kind]||'Anexo'),key=message.id+':'+index+':'+(message.media.attachmentId||message.media.qrId||message.media.id||item.url);
      const media=kind==='shared'?'<div data-shared-url="'+url+'" data-shared-label="'+label+'">Carregando mídia compartilhada…</div>':kind==='image'||kind==='sticker'?'<a href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" loading="lazy" alt="'+label+'"></a>':kind==='audio'?'<audio controls preload="metadata" src="'+url+'" aria-label="'+label+'"></audio>':kind==='video'?'<video controls preload="metadata" src="'+url+'" aria-label="'+label+'"></video>':'<a href="'+url+join+'preview=1" target="_blank" rel="noopener">📄 Ver '+label+'</a>';
      const type=labels[kind]||'Compartilhamento',direction=message.direction==='out'?'Enviado':'Recebido',size=message.media?.size?' · '+fileSize(message.media.size):'';
      return '<div class="message-media attachment-card" data-media-key="'+esc(key)+'"><div class="attachment-card-heading"><span class="attachment-type-icon">'+uiIcon(kind==='sticker'?'image':kind)+'</span><div><strong title="'+label+'">'+label+'</strong><small>'+esc(type)+' · '+direction+size+'</small></div></div><div class="attachment-card-preview">'+media+'</div><div class="attachment-card-actions"><a href="'+url+join+'preview=1" target="_blank" rel="noopener" aria-label="Abrir '+label+'">'+uiIcon('open')+'<span>Abrir</span></a><a href="'+url+join+'download=1" aria-label="Baixar '+label+'">'+uiIcon('download')+'<span>Baixar</span></a></div><p class="media-error" hidden>Este anexo não carregou. <button type="button" class="secondary" data-media-retry>Tentar novamente</button></p></div>';
    }).join('')+(message.media.caption?'<p>'+esc(message.media.caption)+'</p>':'');
  }
  const reactions=(message.reactions||[]).map(r=>'<span class="message-reaction" title="Reação do cliente" aria-label="Reação do cliente: '+esc(r.emoji)+'">'+esc(r.emoji)+'</span>').join('');
  return content+(reactions?'<div class="message-reactions">'+reactions+'</div>':'');
}
export function bindMessageMedia(root){
  for(const wrapper of root.querySelectorAll('.message-media')){
    if(wrapper.dataset.bound)continue;wrapper.dataset.bound='true';
    const error=wrapper.querySelector('.media-error'),shared=wrapper.querySelector('[data-shared-url]');
    const bind=element=>{element.addEventListener('error',()=>error.hidden=false);wrapper.querySelector('[data-media-retry]').onclick=()=>{error.hidden=true;const url=new URL(element.src,location.origin);url.searchParams.set('retry',Date.now());element.src=url.href;if(['AUDIO','VIDEO'].includes(element.tagName))element.load();};};
    if(shared){
      const load=async()=>{try{error.hidden=true;const response=await fetch(shared.dataset.sharedUrl,{method:'HEAD'});if(!response.ok)throw Error('Mídia indisponível.');
        const kind=response.headers.get('x-attachment-kind');if(!['image','audio','video'].includes(kind)){const link=document.createElement('a');link.href=shared.dataset.sharedUrl+'&preview=1';link.target='_blank';link.rel='noopener';link.textContent='📄 Ver arquivo compartilhado';shared.replaceChildren(link);return;}
        const element=document.createElement(kind==='image'?'img':kind);element.src=shared.dataset.sharedUrl;if(kind==='image')element.alt=shared.dataset.sharedLabel;else{element.controls=true;element.preload='metadata';element.setAttribute('aria-label',shared.dataset.sharedLabel);}shared.replaceChildren(element);bind(element);
      }catch{shared.textContent='Mídia compartilhada indisponível.';error.hidden=false;wrapper.querySelector('[data-media-retry]').onclick=load;}};load();
    }else{const element=wrapper.querySelector('img,audio,video');if(element)bind(element);}
  }
}
