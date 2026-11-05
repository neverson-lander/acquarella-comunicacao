const zone='America/Sao_Paulo';
const clock=new Intl.DateTimeFormat('pt-BR',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit'});
const date=new Intl.DateTimeFormat('pt-BR',{timeZone:zone,day:'2-digit',month:'2-digit',year:'numeric'});
const valid=value=>Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=8640000000000000;

function stamp(label,value,description){
  if(!valid(value))return `<span>${label}: não registrado</span>`;
  const n=Number(value),title=`${description} · ${date.format(n)} ${clock.format(n)} (Brasília)`;
  return `<span title="${title}">${label}: <time datetime="${new Date(n).toISOString()}">${date.format(n)} ${clock.format(n)}</time></span>`;
}

export function createMessageTiming(){
  return (message,scope)=>{
    if(message.direction!=='in')return '';
    const key=`${scope}:${message.id}`;
    const presentation=valid(message.first_viewed_at)?stamp('Primeira visualização',message.first_viewed_at,'Primeira pessoa que teve a mensagem visível na central; horário registrado pelo servidor'):'<span>Primeira visualização: ainda não registrada</span>';
    const panelId=`message-timing-${encodeURIComponent(key)}`;
    return `<span class="message-timing"><button type="button" class="message-timing-trigger" popovertarget="${panelId}" aria-label="Ver horários da mensagem" aria-describedby="${panelId}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button><span id="${panelId}" class="message-timing-info" popover="auto" role="tooltip"><strong>Horários da mensagem · Brasília</strong>${stamp('Enviada pelo cliente',message.created,'Horário informado pelo canal')}${stamp('Recebida na central',message.received_at,'Chegada ao processamento da central')}${presentation}</span></span>`;
  };
}

export function bindMessageTiming(root){
  if(root.dataset.timingBound)return;
  root.dataset.timingBound='true';
  const place=panel=>{
    const button=panel.parentElement.querySelector('button'),rect=button.getBoundingClientRect();
    panel.style.left=`${Math.max(12,Math.min(rect.right-panel.offsetWidth,innerWidth-panel.offsetWidth-12))}px`;
    const above=rect.top-panel.offsetHeight-8;
    panel.style.top=`${Math.max(12,Math.min(above>=12?above:rect.bottom+8,innerHeight-panel.offsetHeight-12))}px`;
  };
  root.addEventListener('toggle',e=>{if(e.target.matches('.message-timing-info')&&e.newState==='open')place(e.target);},true);
  const show=e=>{
    if(e.type==='pointerover'&&e.pointerType!=='mouse')return;
    if(e.type==='focusin'&&!e.target.matches(':focus-visible'))return;
    const widget=e.target.closest('.message-timing');if(!widget)return;
    const panel=widget.querySelector('[popover]');if(!panel.matches(':popover-open'))panel.showPopover();place(panel);
  };
  const hide=e=>{
    if(e.type==='pointerout'&&e.pointerType!=='mouse')return;
    const widget=e.target.closest('.message-timing');if(!widget||widget.contains(e.relatedTarget))return;
    widget.querySelector('[popover]').hidePopover();
  };
  root.addEventListener('pointerover',show);root.addEventListener('pointerout',hide);
  root.addEventListener('focusin',show);root.addEventListener('focusout',hide);
  // Keep floating information attached to its message while the history moves.
  root.addEventListener('scroll',()=>{for(const panel of root.querySelectorAll('.message-timing-info:popover-open'))panel.hidePopover();},true);
}
