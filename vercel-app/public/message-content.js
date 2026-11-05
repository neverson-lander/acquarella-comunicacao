import {canQuoteMessage} from './quoted-reply.mjs';
import {uiIcon,fileSize} from './message-icons.js';
export function messageContent(message,esc,{canReply=false}={}){
  const labels={image:'Imagem',sticker:'Figurinha',audio:'Áudio',video:'Vídeo',file:'Arquivo',document:'Documento'};
  let content='<p>'+esc(message.body)+'</p>';
  if(['deleted','unsupported'].includes(message.kind))content='<div class="message-notice">'+uiIcon('info')+'<span>'+esc(message.kind==='deleted'?'Mensagem excluída no canal de origem.':'Este conteúdo nativo não foi disponibilizado pela Meta. Visualize no canal de origem.')+'</span></div>';
  const items=message.media?.items||((message.media?.attachmentId||message.media?.qrId||message.media?.id)&&labels[message.kind]?[{kind:message.kind,name:message.media.name}]:[]);
  if(items.length){
    // Older QR messages keep their caption in body, rather than media.caption.
    // Preserve that text when replacing the normal body with an attachment card.
    let caption=String(message.media.caption||message.body||'').trim();
    if(!message.media.caption&&(message.media.attachmentId&&caption===message.media.name||/^\[(?:Imagem|Vídeo|Áudio|Documento|Figurinha|Anexo|Arquivo|Mensagem não textual)(?: recebida| recebido)?(?: no WhatsApp)?\]$/i.test(caption)))caption='';
    content=items.map((item,index)=>{
      const base='/api/messages/'+encodeURIComponent(message.id)+'/media',query=message.media?.items?'?attachment='+index:'',url=base+query,join=query?'&':'?',kind=item.kind,label=esc(item.name||labels[kind]||'Anexo'),key=message.id+':'+index+':'+(message.media.attachmentId||message.media.qrId||message.media.id||item.url);
      const media=kind==='shared'?'<div data-shared-url="'+url+'" data-shared-label="'+label+'">Carregando mídia compartilhada…</div>':kind==='image'||kind==='sticker'?'<a href="'+url+'" target="_blank" rel="noopener"><img src="'+url+'" loading="lazy" alt="'+label+'"></a>':kind==='audio'?'<audio controls preload="metadata" src="'+url+'" aria-label="'+label+'"></audio>':kind==='video'?'<video controls preload="metadata" src="'+url+'" aria-label="'+label+'"></video>':'<a href="'+url+join+'preview=1" target="_blank" rel="noopener">📄 Ver '+label+'</a>';
      const type=labels[kind]||'Compartilhamento',direction=message.direction==='out'?'Enviado':'Recebido',size=message.media?.size?' · '+fileSize(message.media.size):'';
      return '<div class="message-media attachment-card" data-media-key="'+esc(key)+'"><div class="attachment-card-heading"><span class="attachment-type-icon">'+uiIcon(kind==='sticker'?'image':kind)+'</span><div><strong title="'+label+'">'+label+'</strong><small>'+esc(type)+' · '+direction+size+'</small></div></div><div class="attachment-card-preview">'+media+'</div><div class="attachment-card-actions"><a href="'+url+join+'preview=1" target="_blank" rel="noopener" aria-label="Abrir '+label+'">'+uiIcon('open')+'<span>Abrir</span></a><a href="'+url+join+'download=1" aria-label="Baixar '+label+'">'+uiIcon('download')+'<span>Baixar</span></a></div><p class="media-error" hidden>Este anexo não carregou. <button type="button" class="secondary" data-media-retry>Tentar novamente</button></p></div>';
    }).join('')+(caption?'<p class="media-caption">'+esc(caption)+'</p>':'');
  }
  const reactions=(message.reactions||[]).map(r=>{const label=r.from_me?'Reação pelo WhatsApp vinculado':'Reação do cliente';return '<span class="message-reaction" title="'+label+'" aria-label="'+label+': '+esc(r.emoji)+'">'+esc(r.emoji)+'</span>';}).join('');
  const deletion=message.deletion?'<div class="message-deletion-notice" role="note">'+(message.deletion.source==='central'?'Exclusão solicitada no WhatsApp':'Excluída no WhatsApp')+' · Conteúdo preservado na central.</div>':'';
  const menu=!message.deletion?[
    message.can_edit?'<button type="button" data-edit-message="'+esc(message.id)+'">Editar mensagem</button>':'',
    message.can_forward?'<button type="button" data-forward-message="'+esc(message.id)+'">Encaminhar mensagem</button>':'',
    message.media?.edited&&message.media.edited.source!=='whatsapp'?'<button type="button" data-edit-history="'+esc(message.id)+'">Histórico de edições</button>':'',
    message.can_delete?'<button type="button" data-delete-message="'+esc(message.id)+'">Excluir no WhatsApp</button>':''
  ].join(''):'';
  const remove=menu?'<details class="message-more"><summary aria-label="Mais ações da mensagem" title="Mais ações da mensagem">⋯</summary><div class="message-action-menu">'+menu+'</div></details>':'';
  const react=message.can_react&&!message.deletion?'<button type="button" class="message-react-action" title="Reagir à mensagem" aria-label="Reagir à mensagem" data-react-message="'+esc(message.id)+'">'+uiIcon('emoji')+'</button>':'';
  const reply=canReply&&canQuoteMessage(message)?'<button type="button" class="message-reply-action" title="Responder a esta mensagem" aria-label="Responder a esta mensagem" data-reply-message="'+esc(message.id)+'">'+uiIcon('reply')+'</button>':'';
  const quote=message.media?.replyTo?'<div class="message-quoted-context" role="note" aria-label="Mensagem respondida"><strong>'+esc(message.media.replyTo.name)+'</strong><p>'+esc(message.media.replyTo.body)+'</p></div>':'';
  const actions=reply||react||remove?'<div class="message-actions" role="group" aria-label="Ações da mensagem">'+reply+react+remove+'</div>':'';
  const forwarded=message.media?.forwarded?'<small class="message-forwarded-note">↪ Encaminhada</small>':'';
  const edited=message.media?.edited?'<small class="message-edited-note">Editada</small>':'';
  return forwarded+quote+content+edited+(reactions?'<div class="message-reactions">'+reactions+'</div>':'')+deletion+actions;
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
