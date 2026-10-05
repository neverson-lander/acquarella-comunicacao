const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// The standalone manual is also the source for the in-app help: one editable copy.
export function createHelpUi() {
  let manual, loading, active = 'primeiros-passos', query = '';
  async function load() {
    if (manual) return manual;
    if (!loading) loading = fetch('/manual.html').then(async response => {
      if (!response.ok) throw Error('Manual indisponível');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      manual = [...doc.querySelectorAll('article[data-help]')].map(article => ({
        id: article.id, title: article.querySelector('h2').textContent,
        group: article.dataset.help, html: article.outerHTML, text: normalize(article.textContent)
      }));
      if (!manual.length) throw Error('Manual vazio');
      return manual;
    }).catch(error => { loading = null; throw error; });
    return loading;
  }
  function showArticle(root, id, focus = false) {
    const article = manual.find(item => item.id === id);
    if (!article) return;
    active = id;
    root.querySelector('#help-article').innerHTML = article.html;
    root.querySelectorAll('[data-help-topic]').forEach(button => {
      if (button.dataset.helpTopic === id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (focus) {
      const target = root.querySelector('#help-article');
      target.focus({preventScroll: true});
      target.scrollIntoView({block: 'start'});
    }
  }
  function showTopics(root) {
    const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
    const matches = manual.filter(item => words.every(word => item.text.includes(word)));
    const list = root.querySelector('#help-topics');
    list.replaceChildren();
    for (const group of new Set(matches.map(item => item.group))) {
      const heading = document.createElement('h3');
      heading.textContent = group;
      list.append(heading);
      for (const item of matches.filter(item => item.group === group)) {
        const button = document.createElement('button');
        button.type = 'button'; button.dataset.helpTopic = item.id; button.textContent = item.title;
        button.onclick = () => showArticle(root, item.id, true);
        list.append(button);
      }
    }
    root.querySelector('#help-count').textContent = `${matches.length} de ${manual.length} assuntos`;
    if (!matches.length) {
      const message = document.createElement('p');
      message.textContent = 'Nenhum assunto encontrado. Tente “token”, “agendamento” ou o nome do canal.';
      list.append(message);
    }
    // Keep the currently read chapter open when refining a search.
    showArticle(root, active);
  }
  async function render(topic) {
    if (topic) { active = topic; query = ''; }
    const content = document.querySelector('#content');
    content.innerHTML = '<p role="status">Carregando a ajuda…</p>';
    try {
      await load();
      // A user may navigate elsewhere while the manual is loading.
      if (!content.isConnected || !content.querySelector('[role="status"]')) return;
      content.innerHTML = `<section class="help-center" aria-label="Central de ajuda">
        <div class="help-toolbar"><label for="help-search">Buscar no manual<input type="search" id="help-search" placeholder="Ex.: conectar Instagram, token, encerrar" aria-controls="help-topics"></label><a class="secondary" href="/manual.html" target="_blank" rel="noopener">Manual completo / imprimir ↗</a></div>
        <div class="help-layout"><nav class="help-index" aria-label="Assuntos da ajuda"><p id="help-count" role="status"></p><div id="help-topics"></div></nav><div id="help-article" class="help-document" tabindex="-1" aria-label="Conteúdo do assunto"></div></div>
      </section>`;
      const input = content.querySelector('#help-search');
      input.value = query;
      input.oninput = () => { query = input.value; showTopics(content); };
      showTopics(content);
      content.querySelector('#help-article').onclick = event => {
        const link = event.target.closest('a[href^="#"]');
        if (!link || !manual.some(item => item.id === link.hash.slice(1))) return;
        event.preventDefault(); showArticle(content, link.hash.slice(1), true);
      };
    } catch {
      if (content.isConnected) content.innerHTML = '<p role="alert">Não foi possível carregar a ajuda. Use Atualizar para tentar novamente ou abra o <a href="/manual.html">manual completo</a>.</p>';
    }
  }
  return {render};
}
