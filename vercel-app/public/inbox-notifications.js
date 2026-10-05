export function createInboxNotifications({openConversation}) {
  let entries = [], counter = 0;
  const container = document.createElement('aside');
  container.className = 'incoming-notifications';
  container.setAttribute('aria-label', 'Avisos de mensagens');
  const announce = document.createElement('div');
  announce.className = 'sr-only'; announce.setAttribute('role', 'status'); announce.setAttribute('aria-live', 'polite');
  document.body.append(container, announce);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render() {
    container.innerHTML = entries.filter(entry => entry.visible).slice(0, 2).map(entry => `<div class="incoming-card"><button type="button" class="incoming-open" data-incoming="${entry.id}"><small>${entry.kind === 'queue' ? 'Nova mensagem na fila' : 'Resposta no seu atendimento'}</small><strong>${escape(entry.name)}</strong><span>${entry.count > 1 ? `${entry.count} novas mensagens · ` : ''}Abrir conversa →</span></button><button type="button" class="incoming-dismiss" data-dismiss="${entry.id}" aria-label="Fechar aviso de ${escape(entry.name)}">×</button></div>`).join('');
    container.querySelectorAll('[data-incoming]').forEach(button => button.onclick = () => {
      const entry = entries.find(item => item.id === Number(button.dataset.incoming));
      openConversation(entry.conversation);
    });
    container.querySelectorAll('[data-dismiss]').forEach(button => button.onclick = () => {
      entries.find(item => item.id === Number(button.dataset.dismiss)).visible = false; render();
    });
  }
  function add(changes) {
    for (const change of changes) {
      const entry = {...change, id: ++counter, visible: true, created: Date.now()};
      entries.unshift(entry);
      setTimeout(() => { entry.visible = false; render(); }, 12000);
    }
    entries = entries.slice(0, 30);
    if (changes.length) announce.textContent = changes.map(c => `${c.kind === 'queue' ? 'Nova mensagem na fila' : 'Resposta no seu atendimento'}: ${c.name}.`).join(' ');
    render();
  }
  function read(conversation) { entries = entries.filter(e => e.conversation !== conversation); render(); }
  function prune(conversations) { const allowed = new Set(conversations.map(c => c.id)); entries = entries.filter(e => allowed.has(e.conversation)); render(); }
  function show() { entries.slice(0, 3).forEach(e => { e.visible = true; }); render(); }
  function clear() { entries = []; announce.textContent = ''; render(); }
  return {add, read, prune, show, clear, count: () => entries.length};
}
