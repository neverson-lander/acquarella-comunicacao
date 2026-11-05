export function createInboxNotifications({openConversation}) {
  let entries = [], counter = 0;
  const container = document.createElement('aside');
  container.className = 'incoming-notifications';
  container.setAttribute('aria-label', 'Avisos de mensagens');
  const announce = document.createElement('div');
  announce.className = 'sr-only'; announce.setAttribute('role', 'status'); announce.setAttribute('aria-live', 'polite');
  document.body.append(container, announce);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const title=entry=>entry.kind==='queue'?'Nova mensagem na fila':entry.message?.direction==='out'?'Mensagem enviada no atendimento':entry.kind==='mine'?'Nova mensagem no seu atendimento':'Nova mensagem em atendimento';
  function render() {
    container.innerHTML = entries.filter(entry => entry.visible).map(entry => `<div class="incoming-card"><button type="button" class="incoming-open" data-incoming="${entry.id}"><small>${title(entry)}</small><strong>${escape(entry.name)}</strong>${entry.owner?`<span>Responsável: ${escape(entry.owner)}</span>`:''}<span>${entry.count > 1 ? `${entry.count} novas mensagens · ` : ''}Abrir conversa →</span></button><button type="button" class="incoming-dismiss" data-dismiss="${entry.id}" aria-label="Fechar aviso de ${escape(entry.name)}">×</button></div>`).join('');
    container.querySelectorAll('[data-incoming]').forEach(button => button.onclick = () => {
      const entry = entries.find(item => item.id === Number(button.dataset.incoming));
      openConversation(entry.conversation);
    });
    container.querySelectorAll('[data-dismiss]').forEach(button => button.onclick = () => {
      entries.find(item => item.id === Number(button.dataset.dismiss)).visible = false; render();
    });
  }
  function add(changes,{silent=false}={}) {
    for (const change of changes) {
      const previous=entries.find(e=>e.conversation===change.conversation);
      const entry = {...change, count:(previous?.count||0)+change.count, id: ++counter, visible: !silent, created: Date.now()};
      entries=entries.filter(e=>e.conversation!==change.conversation);entries.unshift(entry);
    }
    if (changes.length&&!silent) announce.textContent = changes.map(c => `${title(c)}: ${c.name}.`).join(' ');
    render();
  }
  function read(conversation) { entries = entries.filter(e => e.conversation !== conversation); render(); }
  function prune(conversations) { const allowed = new Set(conversations.filter(c=>c.status==='open'&&c.attendance_eligible!==false).map(c => c.id));entries = entries.filter(e => allowed.has(e.conversation)); render(); }
  function show() { entries.slice(0, 3).forEach(e => { e.visible = true; }); render(); }
  function silence(ids){for(const e of entries)if(!ids||ids.has(e.conversation))e.visible=false;render();}
  function clear() { entries = []; announce.textContent = ''; render(); }
  return {add, read, prune, show, silence, clear, count: () => entries.length};
}
