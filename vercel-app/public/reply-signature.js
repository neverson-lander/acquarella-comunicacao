export function createReplySignatureUi({getState,toast}){
 const choices=new Map();
 function bind(form,{conversation,account,readonly}){
  const state=getState();if(state.user.role!=='admin'||readonly)return;
  const permitted=u=>u.role==='admin'||(Array.isArray(u.accounts)?u.accounts:JSON.parse(u.accounts||'[]')).includes(account.id);
  const team=(state.crm.team||[]).filter(u=>u.role!=='viewer'&&permitted(u));if(!team.some(u=>u.id===state.user.id))team.push(state.user);
  const available=id=>team.some(u=>u.id===id),saved=choices.get(conversation.id),initial=available(saved)?saved:available(conversation.assigned_to)?conversation.assigned_to:state.user.id;
  const row=document.createElement('div');row.className='reply-signature';const label=document.createElement('label');label.textContent='Assinar como';const select=document.createElement('select');select.dataset.replySigner='';select.setAttribute('aria-label','Assinar mensagem como');
  for(const user of team){const option=document.createElement('option');option.value=user.id;option.textContent=user.name+(user.id===state.user.id?' (você)':user.id===conversation.assigned_to?' (responsável pelo atendimento)':'');select.append(option);}select.value=initial;label.append(select);row.append(label);const note=document.createElement('small');note.textContent='Seu envio fica registrado internamente como administrador.';row.append(note);label.title=note.textContent;form.querySelector('textarea').before(row);
  const update=()=>{choices.set(conversation.id,select.value);const signer=team.find(u=>u.id===select.value),input=form.querySelector('textarea');input.maxLength=2000-Math.min(signer.name.replace(/\s+/g,' ').trim().length,120)-2;input.dispatchEvent(new Event('input',{bubbles:true}));if(input.value.length>input.maxLength)toast('O texto excede o limite com esta assinatura. Reduza a mensagem antes de enviar.');};select.onchange=update;update();
 }
 return {bind,clear:()=>choices.clear(),value:form=>form.querySelector('[data-reply-signer]')?.value};
}
