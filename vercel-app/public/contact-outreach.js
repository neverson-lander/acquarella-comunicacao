import {channelIcon,channelNames} from './channel-brand.js';
import {displayContactPhone} from './contact-domain.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createOutreachUi({getState,api,modal,toast,openConversation}){
  function search(){
    let sequence=0;
    modal('Buscar cliente e enviar mensagem',`<p>Encontre um cliente e envie pelo canal em que ele está cadastrado.</p><label>Nome, telefone ou e-mail<input type="search" name="query" minlength="2" maxlength="150" required autofocus placeholder="Digite ao menos 2 caracteres"></label><label>Canal<select name="account"><option value="">Todos os canais</option>${getState().accounts.filter(a=>!a.deleted_at).map(a=>`<option value="${esc(a.id)}">${esc(channelNames[a.channel])} · ${esc(a.name)}</option>`).join('')}</select></label><div class="outreach-results" aria-live="polite"></div>`,async()=>{});
    const form=document.querySelector('#modal-form'),results=form.querySelector('.outreach-results'),button=form.querySelector('.primary');button.textContent='Buscar clientes';
    // Search stays in this dialog; selecting a result opens the individual composer.
    form.onsubmit=async e=>{e.preventDefault();const current=++sequence;button.disabled=true;results.textContent='Buscando clientes…';try{
      const values=new FormData(form),data=await api('outreach/search?'+new URLSearchParams({q:values.get('query'),account:values.get('account')}));
      if(current!==sequence||!form.isConnected)return;
      results.innerHTML=data.items.map(c=>`<article class="outreach-client"><strong>${esc(c.name)}</strong><span>${esc(displayContactPhone(c.phone)||c.email||'Contato pelo canal')}</span><span class="contact-channel">${channelIcon(c.account.channel)} ${esc(channelNames[c.account.channel])} · ${esc(c.account.name)}</span>${c.reason?`<p>${esc(c.reason)}</p>`:''}<button type="button" class="${c.canSend?'primary':'secondary'}" data-outreach-client="${esc(c.id)}" ${c.canSend?'':'disabled'}>Escrever mensagem</button></article>`).join('')||'<p>Nenhum cliente encontrado neste filtro.</p>';
      if(data.hasMore)results.insertAdjacentHTML('beforeend','<p>Há mais resultados. Refine a busca pelo nome ou telefone.</p>');
      results.querySelectorAll('[data-outreach-client]').forEach(b=>b.onclick=()=>compose(b.dataset.outreachClient).catch(e=>toast(e.message)));
    }catch(e){if(form.isConnected)results.textContent=e.message;}finally{if(button.isConnected)button.disabled=false;}};
  }
  async function compose(id){
    const c=await api('outreach/contact/'+id);if(!c.canSend)throw Error(c.reason);
    let requestId=crypto.randomUUID();
    modal('Enviar mensagem ao cliente',`<div class="outreach-destination"><strong>${esc(c.name)}</strong><p>${esc(displayContactPhone(c.phone)||c.email)}</p><span class="contact-channel">${channelIcon(c.account.channel)} ${esc(channelNames[c.account.channel])} · ${esc(c.account.name)}</span></div><p>A mensagem abrirá o atendimento em seu nome neste canal.</p><label>Mensagem<textarea name="body" rows="5" required maxlength="2000" placeholder="Escreva a mensagem para o cliente"></textarea></label><small>Sua assinatura será incluída no envio.</small>`,async f=>{
      const sent=await api('outreach/send',{id:requestId,contact:c.id,body:f.get('body')});
      if(sent.state==='failed'){requestId=crypto.randomUUID();throw Error(sent.error||'Falha no envio. Confira o canal antes de tentar novamente.');}
      // The shared modal refreshes state after this handler. Navigation uses the refreshed data.
      return sent;
    },r=>{setTimeout(()=>openConversation(r.conversation),0);return r.state==='sent'?'Mensagem enviada.':r.state==='uncertain'?'Entrega não confirmada. Confira o atendimento antes de repetir o envio.':'Mensagem na fila de envio. Acompanhe pelo atendimento.';});
    const button=document.querySelector('#modal-form .primary');button.textContent='Enviar mensagem';
  }
  return {search,compose};
}
