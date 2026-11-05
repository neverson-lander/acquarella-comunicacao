import {createFirstViewTracker} from './message-first-view.js?v=20261031';
import {messageContent,bindMessageMedia} from './message-content.js?v=20261022-actions-ux';
import {withFeedback} from './action-feedback.js';

export function createFinalizedUi({api,getState,esc,toast,active,onScope,onReopen,onIndicators}){
  let items=[],nextCursor=null,term='',selected=null,detail=null,generation=0,session='',busy=false;
  const root=()=>document.querySelector('#finalized-root');
  const firstViews=createFirstViewTracker({api,onRecorded:(cid,messages)=>{if(detail?.conversation.id!==cid)return;for(const record of messages){const message=detail.conversation.messages.find(m=>m.id===record.id);if(message)message.first_viewed_at=record.first_viewed_at;}}});
  const stamp=value=>new Date(Number(value)).toLocaleString('pt-BR');
  function reset(){generation++;items=[];nextCursor=null;term='';selected=null;detail=null;session='';busy=false;}
  function render(tabs){
    const identity=getState().tenant.id+':'+getState().user.id;if(identity!==session){reset();session=identity;}
    generation++;busy=false;
    document.querySelector('#content').innerHTML=`<div id="finalized-root"><div class="inbox-controls">${tabs}<button type="button" class="secondary" data-finalized-refresh>↻ Atualizar finalizados</button></div><p class="finalized-help">Pesquise por nome ou parte do telefone. Inclui encerramentos normais e em massa dos seus canais.</p><section class="inbox finalized-inbox ${selected?'mobile-chat':''}" aria-label="Atendimentos finalizados"><div class="conversation-list"><form class="finalized-search"><label for="finalized-query">Nome ou telefone</label><div><input id="finalized-query" name="q" maxlength="100" autocomplete="off" placeholder="Ex.: Maria ou 9988" value="${esc(term)}"><button class="primary" type="submit">Buscar</button></div></form><p class="finalized-status" role="status" aria-live="polite"></p><div class="finalized-results"></div><button type="button" class="secondary finalized-more" hidden>Carregar mais resultados</button></div><div class="chat finalized-chat"></div></section></div>`;
    const el=root();el.querySelectorAll('[data-attendance-scope]').forEach(button=>button.onclick=()=>{generation++;onScope(button.dataset.attendanceScope);});
    el.querySelector('#open-finalized').onclick=()=>search(false);
    el.querySelector('[data-finalized-refresh]').onclick=()=>search(false);
    el.querySelector('form').onsubmit=event=>{event.preventDefault();term=el.querySelector('input').value.trim();selected=null;detail=null;el.querySelector('.inbox').classList.remove('mobile-chat');paintDetail();search(false);};
    el.querySelector('.finalized-more').onclick=()=>search(true);
    onIndicators();paintList();paintDetail();search(false);
  }
  function paintList(){
    if(!root())return;
    const state=getState(),list=root().querySelector('.finalized-results');
    list.innerHTML=items.map(c=>`<button type="button" class="conversation ${selected===c.id?'selected':''}" data-finalized-id="${esc(c.id)}"><div><div class="conversation-title"><strong>${esc(c.name)}</strong><small>Finalizado</small></div><p>${esc(c.customer)}</p><span class="conversation-channel">${esc(state.accounts.find(a=>a.id===c.account)?.name||'Canal')} · ${esc(stamp(c.updated))}</span><span class="conversation-channel">${esc(c.assignee_name||'Encerrado sem responsável')}</span></div></button>`).join('');
    list.querySelectorAll('[data-finalized-id]').forEach(button=>button.onclick=()=>open(button.dataset.finalizedId));
    root().querySelector('.finalized-more').hidden=!nextCursor;
  }
  async function search(more){
    if(busy)return;busy=true;
    const token=++generation,el=root(),cursor=more?nextCursor:null;if(!el){busy=false;return;}
    const status=el.querySelector('.finalized-status');status.textContent='Buscando atendimentos…';
    const buttons=[...el.querySelectorAll('.finalized-search button,.finalized-more,[data-finalized-refresh],[data-finalized-id]')];buttons.forEach(b=>b.disabled=true);
    try{
      const data=await api('finalized-attendances?q='+encodeURIComponent(term)+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(token!==generation||!active()||!root())return;
      const combined=more?[...items,...data.items]:data.items;items=[...new Map(combined.map(c=>[c.id,c])).values()];nextCursor=data.nextCursor;
      status.textContent=items.length?`${items.length} resultado(s) carregado(s)${nextCursor?' · há mais resultados':''}`:'Nenhum finalizado encontrado para esta busca.';
      paintList();
    }catch(error){if(token===generation&&active())status.textContent=error.message;}
    finally{if(token===generation){busy=false;buttons.forEach(b=>b.disabled=false);}}
  }
  async function open(id){
    const token=++generation;busy=false;selected=id;detail=null;paintList();paintDetail('Carregando histórico…');
    root().querySelector('.inbox').classList.add('mobile-chat');
    try{const data=await api('finalized-attendances/'+encodeURIComponent(id));if(token!==generation||!active()||!root())return;detail=data;paintDetail();}
    catch(error){if(token===generation&&active())paintDetail(error.message);}
  }
  function paintDetail(notice){
    const chat=root()?.querySelector('.finalized-chat');if(!chat)return;
    if(!detail){chat.innerHTML=`<div class="finalized-detail-empty"><button type="button" class="secondary" data-finalized-back>← Voltar aos resultados</button><h3>${selected?'Histórico do atendimento':'Atendimentos finalizados'}</h3><p role="status">${esc(notice||'Selecione um resultado para consultar o histórico.')}</p></div>`;chat.querySelector('[data-finalized-back]').onclick=()=>root().querySelector('.inbox').classList.remove('mobile-chat');return;}
    const c=detail.conversation;
    chat.innerHTML=`<header class="chat-header"><button type="button" class="secondary finalized-back" data-finalized-back aria-label="Voltar aos resultados">←</button><div class="customer-heading"><strong>${esc(c.name)}</strong><small>${esc(c.customer)} · Finalizado</small></div>${detail.canReopen?'<button type="button" class="primary" data-finalized-reopen>Reabrir e responder</button>':'<span class="finalized-readonly">Histórico para consulta</span>'}</header><p class="finalized-reopen-note">${detail.canReopen?'Ao reabrir, o atendimento fica com você em Meus atendimentos. Nenhuma mensagem é enviada automaticamente.':'Seu perfil ou o estado do canal não permite reabrir este atendimento.'}</p><div class="messages"><button type="button" class="secondary finalized-older" ${detail.nextMessagesCursor?'':'hidden'}>Carregar mensagens anteriores</button>${c.messages.length?c.messages.map(m=>`<div data-message-id="${esc(m.id)}" class="message ${m.direction==='out'?'out':'in'}"><small>${esc(m.direction==='out'?(m.signature_name||m.operator_name||'Equipe'):c.name)}</small>${messageContent(m,esc)}<footer>${esc(stamp(m.created))}</footer></div>`).join(''):'<p class="finalized-no-messages">Este atendimento foi encerrado sem mensagens registradas.</p>'}</div><details class="finalized-events"><summary>Histórico de encerramentos e responsáveis</summary>${(c.attendance_history||[]).map(h=>`<p><strong>${esc(h.action)}</strong> · ${esc(h.actor_name)} · ${esc(stamp(h.created))}${h.reason?'<br>'+esc(h.reason):''}</p>`).join('')||'<p>Sem alterações registradas.</p>'}</details>`;
    chat.querySelector('[data-finalized-back]').onclick=()=>root().querySelector('.inbox').classList.remove('mobile-chat');
    const reopen=chat.querySelector('[data-finalized-reopen]');if(reopen)reopen.onclick=()=>withFeedback(reopen,'Reabrindo…',async()=>{try{const result=await api('finalized-attendances/'+c.id+'/reopen',{});if(!active()||!root())return;items=items.filter(item=>item.id!==c.id);selected=null;detail=null;generation++;onReopen(result);toast('Atendimento reaberto. Escreva sua resposta.');}catch(error){toast(error.message);}});
    chat.querySelector('.finalized-older').onclick=async event=>{
      const button=event.currentTarget,token=generation,scroll=chat.querySelector('.messages'),height=scroll.scrollHeight;button.disabled=true;
      try{const page=await api('finalized-attendances/'+c.id+'?before='+encodeURIComponent(detail.nextMessagesCursor));if(token!==generation||!active())return;const merged=new Map([...page.conversation.messages,...c.messages].map(m=>[m.id,m]));detail={...page,conversation:{...page.conversation,messages:[...merged.values()]}};paintDetail();const next=root().querySelector('.messages');next.scrollTop=next.scrollHeight-height;}
      catch(error){toast(error.message);}
      finally{if(button.isConnected)button.disabled=false;}
    };
    bindMessageMedia(chat);chat.querySelector('.messages').scrollTop=chat.querySelector('.messages').scrollHeight;firstViews.bind(chat,c,getState().tenant.id+':'+getState().user.id);
  }
  return {render,reset};
}
