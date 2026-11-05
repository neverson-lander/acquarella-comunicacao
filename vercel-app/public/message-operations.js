import {withFeedback} from './action-feedback.js';
import {normalizeContactPhone,displayContactPhone} from './contact-domain.mjs';
export function createMessageOperationsUi({api,getState,esc,toast,onResult}){
 let currentDialog=null,sequence=0;
 const identity=()=>getState()?getState().tenant.id+':'+getState().user.id:'';
 function reset(){sequence++;currentDialog?.close();currentDialog=null;}
 function dialog(title,body){
  if(currentDialog?.open)currentDialog.close();
  const d=document.createElement('dialog');d.className='message-operation-dialog';d.setAttribute('aria-labelledby','message-operation-title');
  d.innerHTML=`<form id="message-operation-form"><div class="message-operation-heading"><h2 id="message-operation-title">${esc(title)}</h2><button type="button" data-operation-close aria-label="Fechar">×</button></div>${body}<p class="form-error" role="alert"></p><div class="message-operation-footer"><button type="button" class="secondary" data-operation-close>Cancelar</button><button type="submit" class="primary" data-operation-save>Salvar</button></div></form>`;
  document.body.append(d);currentDialog=d;const form=d.querySelector('form');let busy=false;
  d.querySelectorAll('[data-operation-close]').forEach(b=>b.onclick=()=>{if(!busy)d.close();});d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});d.addEventListener('close',()=>{if(currentDialog===d)currentDialog=null;d.remove();});
  return {d,form,button:d.querySelector('[data-operation-save]'),error:d.querySelector('.form-error'),show:()=>d.showModal(),setBusy:value=>{busy=value;}};
 }
 function source(data){
  const m=data.message,labels={image:'Imagem',video:'Vídeo',audio:'Áudio',document:'Documento',file:'Arquivo',sticker:'Figurinha'},label=labels[m.kind],url='/api/messages/'+encodeURIComponent(m.id)+'/media',hasMedia=m.media&&(m.media.qrId||m.media.attachmentId||m.media.id);let preview='';
  if(label&&hasMedia){const name=esc(m.media.name||label);preview='<div class="message-operation-media"><small>'+esc(label)+' · '+name+'</small>'+(['image','sticker'].includes(m.kind)?'<img src="'+url+'" alt="'+name+'" loading="lazy">':m.kind==='video'?'<video src="'+url+'" controls preload="metadata"></video>':m.kind==='audio'?'<audio src="'+url+'" controls preload="metadata"></audio>':'<a href="'+url+'?preview=1" target="_blank" rel="noopener">Ver anexo original</a>')+'</div>';}
  return '<p class="message-operation-channel">Via '+esc(data.account.name)+'</p><div class="message-operation-source"><strong>Mensagem selecionada</strong>'+preview+'<p>'+esc(data.forwardBody??m.media?.caption??m.body)+'</p></div>';
 }

 async function open(id,kind){
  const token=++sequence,session=identity();let data;
  try{data=await api('messages/'+id+'/actions');}catch(error){toast(error.message);return;}
  if(token!==sequence||identity()!==session)return;
  if(kind==='edit'&&!data.canEdit)return toast('A edição é permitida para textos enviados há menos de 15 minutos em um atendimento WhatsApp QR ativo.');
  if(kind==='forward'&&!data.canForward)return toast('Assuma o atendimento em um WhatsApp QR ativo para encaminhar.');
  const pending=data.pending?.kind===kind?data.pending:null;
  let operationId=pending?.id||crypto.randomUUID(),locked=!!pending,destination=null,submitting=false;
  const editing=kind==='edit',initial=pending?.input?.body??data.message.body,maxLength=data.message.media?.forwarded||(!data.message.operator_id&&data.message.operator_name==='WhatsApp vinculado')?2000:2000-Math.min(String(data.message.signature_name||data.message.operator_name||'Equipe').replace(/\s+/g,' ').trim().length,120)-2;
  const fields=editing?`<p class="field-note">A edição altera o texto no WhatsApp. O conteúdo anterior permanece no histórico interno. Prazo: até 15 minutos após o envio.</p><label>Novo texto<textarea name="body" rows="7" maxlength="${maxLength}" required>${esc(initial)}</textarea></label>`:`${source(data)}<label for="forward-query">Buscar contato por nome ou telefone</label><div class="forward-search"><input id="forward-query" maxlength="100" placeholder="Digite ao menos 2 caracteres"><button type="button" class="secondary" data-forward-search>Buscar contatos</button></div><div class="forward-targets" aria-live="polite"></div><label>Ou informe o telefone com DDD<input name="phone" inputmode="tel" maxlength="40" placeholder="(34) 99999-9999" value="${esc(pending?.input?.phone||'')}"></label><p class="field-note">O envio usa este mesmo canal WhatsApp. Clientes em atendimento com outra pessoa exigem transferência.</p><div class="forward-destination" role="status"></div>`;
  const ui=dialog(editing?'Editar mensagem enviada':'Encaminhar mensagem',fields),{d,form,button,error}=ui;
  const inputs=[...form.querySelectorAll('input,textarea')];
  function lock(value){locked=value;inputs.forEach(input=>input.disabled=value);form.querySelector('[data-forward-search]')?.toggleAttribute('disabled',value);}
  function review(){
   if(editing)return;
   try{const phone=normalizeContactPhone(form.elements.phone.value);form.querySelector('.forward-destination').textContent='Encaminhar para '+(destination?.name||'+'+phone)+' · '+displayContactPhone(phone)+' · '+data.account.name;button.disabled=false;}
   catch{form.querySelector('.forward-destination').textContent='Selecione um contato ou informe o telefone do destino.';button.disabled=true;}
  }
  if(!editing){
   form.elements.phone.oninput=()=>{destination=null;review();};
   const search=form.querySelector('[data-forward-search]'),query=form.querySelector('#forward-query'),list=form.querySelector('.forward-targets');let searchSequence=0;
   search.onclick=async()=>{if(locked)return;const q=query.value.trim(),local=++searchSequence;if(q.length<2){list.textContent='Digite ao menos 2 caracteres.';return;}search.disabled=true;list.textContent='Buscando contatos…';try{
    const result=await api('messages/'+id+'/forward-targets?q='+encodeURIComponent(q));if(local!==searchSequence||!d.open)return;
    list.innerHTML=result.items.map(c=>`<button type="button" class="forward-target" data-forward-contact="${esc(c.id)}"><strong>${esc(c.name)}</strong><span>${esc(displayContactPhone(c.phone))}</span></button>`).join('')||'<p>Nenhum contato encontrado. Você pode informar o telefone abaixo.</p>';
    list.querySelectorAll('[data-forward-contact]').forEach(b=>b.onclick=()=>{if(locked)return;destination=result.items.find(c=>c.id===b.dataset.forwardContact);form.elements.phone.value=destination.phone;list.querySelectorAll('button').forEach(item=>item.setAttribute('aria-pressed',String(item===b)));review();});
   }catch(cause){if(d.open)list.textContent=cause.message;}finally{if(search.isConnected)search.disabled=locked;}};
   query.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();search.click();}};review();
  }
  button.textContent=pending?'Verificar novamente':editing?'Salvar edição':'Encaminhar mensagem';if(pending){error.textContent='Existe uma ação sem confirmação. Confira o WhatsApp ou verifique novamente, sem criar outro envio.';lock(true);}
  form.onsubmit=event=>{
   event.preventDefault();if(submitting)return;submitting=true;const body=editing?form.elements.body.value:undefined;
   const payload={id:operationId,expected_body:pending?.input?.expected_body??data.message.body,expected_edit:pending?.input?.expected_edit??data.message.media?.edited?.at??0,...(editing?{body}:destination?{contact:destination.id}:{phone:form.elements.phone.value})};
   if(locked&&pending){if(pending.input.contact)payload.contact=pending.input.contact;if(pending.input.phone)payload.phone=pending.input.phone;}
   ui.setBusy(true);inputs.forEach(input=>input.disabled=true);error.textContent='';
   withFeedback(button,editing?'Salvando edição…':'Encaminhando…',async()=>{
    try{
     const result=await api('messages/'+id+'/'+kind,payload);if(identity()!==session||!d.open)return;
     onResult(result);
     if(result.state==='sent'){d.close();toast(editing?'Mensagem editada no WhatsApp.':'Mensagem encaminhada.');return;}
     error.textContent=result.error||(result.state==='sending'?'A ação está em andamento. Verifique novamente em instantes.':'Ação sem confirmação. Confira o WhatsApp antes de tentar novamente.');
     if(['uncertain','sending'].includes(result.state)){lock(true);button.dataset.nextLabel='Verificar novamente';}
     else{operationId=crypto.randomUUID();lock(false);button.dataset.nextLabel=editing?'Salvar edição':'Encaminhar mensagem';}
    }catch(cause){if(d.open){error.textContent=cause.message;if(!locked)inputs.forEach(input=>input.disabled=false);}}
    finally{submitting=false;ui.setBusy(false);if(!locked)inputs.forEach(input=>input.disabled=false);}
   },form).finally(()=>{if(button.isConnected&&button.dataset.nextLabel){button.textContent=button.dataset.nextLabel;delete button.dataset.nextLabel;}});
  };
  ui.show();
 }
 async function history(id){
  const session=identity(),token=++sequence;try{const data=await api('messages/'+id+'/edits');if(session!==identity()||token!==sequence)return;
   const ui=dialog('Histórico de edições',data.items.map(item=>`<article class="message-edit-entry"><strong>${esc(item.actor_name)} · ${esc(new Date(Number(item.created)).toLocaleString('pt-BR'))}</strong><small>${esc({sent:'Confirmada',failed:'Falhou',uncertain:'Não confirmada',sending:'Em andamento'}[item.state]||item.state)}</small><label>Texto anterior</label><pre>${esc(item.previous_body)}</pre><label>Texto solicitado</label><pre>${esc(item.body)}</pre></article>`).join('')||'<p>Nenhuma edição registrada.</p>');ui.button.hidden=true;ui.form.querySelectorAll('[data-operation-close]').forEach(b=>{if(b.textContent==='Cancelar')b.textContent='Fechar';});ui.show();
  }catch(error){toast(error.message);}
 }
 function bind(root){root.querySelectorAll('[data-edit-message],[data-forward-message],[data-edit-history]').forEach(button=>button.onclick=()=>{button.closest('details')?.removeAttribute('open');if(button.dataset.editHistory)return history(button.dataset.editHistory);open(button.dataset.editMessage||button.dataset.forwardMessage,button.dataset.editMessage?'edit':'forward');});}
 return {bind,reset};
}
