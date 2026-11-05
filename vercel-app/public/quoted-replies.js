import {canQuoteMessage,quoteExcerpt} from './quoted-reply.mjs';
export function createQuotedReplies({getState,toast,isBusy}){
  const choices=new Map();
  function bind(root,form,{conversation,account,readonly}){
    if(!form)return;
    const id=conversation.id;
    let preview=form.querySelector('.reply-quote-preview');
    if(!preview){preview=document.createElement('div');preview.className='reply-quote-preview';preview.setAttribute('role','note');preview.setAttribute('aria-label','Mensagem à qual você está respondendo');form.querySelector('textarea').before(preview);}
    function paint(){
      const quote=choices.get(id);preview.replaceChildren();preview.hidden=!quote||readonly;form.classList.toggle('has-quoted-reply',!!quote&&!readonly);
      if(!quote||readonly)return;
      const text=document.createElement('div'),title=document.createElement('strong'),body=document.createElement('p');title.textContent='Respondendo a '+quote.name;body.textContent=quote.body;text.append(title,body);
      const cancel=document.createElement('button');cancel.type='button';cancel.textContent='×';cancel.className='cancel-quoted-reply';cancel.title='Cancelar resposta à mensagem';cancel.setAttribute('aria-label',cancel.title);cancel.onclick=()=>{if(isBusy())return;choices.delete(id);paint();form.querySelector('textarea').focus({preventScroll:true});};preview.append(text,cancel);
    }
    const existing=choices.get(id);if(existing&&!conversation.messages.some(m=>m.id===existing.messageId&&canQuoteMessage(m)))choices.delete(id);
    paint();
    root.querySelectorAll('[data-reply-message]').forEach(button=>button.onclick=()=>{
      if(readonly||account.channel!=='whatsapp')return;
      if(isBusy())return toast('Aguarde o envio atual para selecionar outra mensagem.');
      const current=getState().conversations.find(c=>c.id===id),message=current?.messages.find(m=>m.id===button.dataset.replyMessage);
      if(!canQuoteMessage(message))return toast('Esta mensagem não está mais disponível para responder.');
      choices.set(id,{messageId:message.id,name:current.name,body:quoteExcerpt(message)});paint();form.querySelector('textarea').focus({preventScroll:true});
    });
  }
  return {bind,value:id=>choices.get(id)?.messageId,forget:id=>choices.delete(id),clear:()=>choices.clear(),prune:allowed=>{for(const id of choices.keys())if(!allowed.has(id))choices.delete(id);}};
}
