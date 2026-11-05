import {bindSearchEnter} from './search-enter.js';
import {emojiCatalogue,emojiGroups} from './emoji-catalogue.mjs';
import {whatsappReactionChoices,isWhatsAppReaction} from './whatsapp-reactions.mjs';

const normalize=value=>String(value).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLocaleLowerCase('pt-BR');
const catalogue=emojiCatalogue.map(([emoji,label,group,tags])=>({emoji,label,group,search:normalize(emoji+' '+label+' '+tags)}));
const labels=new Map(catalogue.map(e=>[e.emoji,e.label]));
export function createReactionPicker({current,identity,storage=globalThis.localStorage,esc}){
 const key='acquarella:reaction-usage:'+identity;
 function usage(){try{const value=JSON.parse(storage.getItem(key)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
 const counts=usage();
 const frequent=[...new Set([...Object.keys(counts).filter(isWhatsAppReaction).sort((a,b)=>(Number(counts[b])||0)-(Number(counts[a])||0)),...whatsappReactionChoices])].filter(Boolean).slice(0,8);
 let selected=current||frequent[0];
 const choice=(emoji,label=labels.get(emoji)||emoji)=>'<button type="button" class="reaction-emoji" data-reaction-emoji="'+esc(emoji)+'" aria-label="'+esc(label)+'" title="'+esc(label)+'" aria-pressed="'+(emoji===selected)+'">'+esc(emoji)+'</button>';
 function markup(){return '<section class="reaction-browser" aria-label="Escolher reação"><input type="hidden" name="emoji" value="'+esc(selected)+'"><h3>Mais usados</h3><div class="reaction-frequent">'+frequent.map(e=>choice(e)).join('')+'</div><div class="reaction-search-tools"><label>Buscar emoji<input type="search" data-reaction-search enterkeyhint="search" placeholder="Ex.: coração, sorriso, festa" autocomplete="off"></label><label>Categoria<select data-reaction-category><option value="">Todas as categorias</option>'+emojiGroups.map(([id,name])=>'<option value="'+id+'">'+esc(name.charAt(0).toUpperCase()+name.slice(1))+'</option>').join('')+'</select></label></div><div class="reaction-results-heading"><h3>Todos os emojis</h3><span data-reaction-count role="status"></span></div><div class="reaction-catalogue" tabindex="0" aria-label="Catálogo de emojis"><div class="reaction-catalogue-grid" data-reaction-results></div></div><div class="reaction-selection"><span data-reaction-selection role="status"></span>'+(current?'<button type="button" class="secondary" data-reaction-remove>Remover minha reação</button>':'')+'</div></section>';}
 function bind(root){
  const input=root.querySelector('[name="emoji"]'),results=root.querySelector('[data-reaction-results]'),search=root.querySelector('[data-reaction-search]'),category=root.querySelector('[data-reaction-category]');
  function updateSelection(){input.value=selected;root.querySelectorAll('[data-reaction-emoji]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.reactionEmoji===selected)));root.querySelector('[data-reaction-selection]').textContent=selected?'Selecionado: '+selected+' '+(labels.get(selected)||''):'Sua reação será removida.';}
  function render(){const terms=normalize(search.value).trim().split(/\s+/).filter(Boolean),items=catalogue.filter(e=>(category.value===''||String(e.group)===category.value)&&terms.every(t=>e.search.includes(t)));results.innerHTML=items.map(e=>choice(e.emoji,e.label)).join('')||'<p class="reaction-empty">Nenhum emoji encontrado. Tente outro nome.</p>';root.querySelector('[data-reaction-count]').textContent=items.length+' disponíveis';root.querySelector('.reaction-catalogue').scrollTop=0;}
  root.querySelector('.reaction-browser').addEventListener('click',event=>{const button=event.target.closest('[data-reaction-emoji]');if(button){selected=button.dataset.reactionEmoji;updateSelection();}else if(event.target.closest('[data-reaction-remove]')){selected='';updateSelection();}});
  bindSearchEnter(search,render);
  search.addEventListener('input',render);category.addEventListener('change',render);render();updateSelection();
 }
 function remember(emoji){if(!emoji||!isWhatsAppReaction(emoji))return;try{const values=usage();values[emoji]=Math.max(0,Math.min(1000000,Number(values[emoji])||0))+1;const top=Object.entries(values).filter(([e])=>isWhatsAppReaction(e)).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,64);storage.setItem(key,JSON.stringify(Object.fromEntries(top)));}catch{}}
 return {markup,bind,remember};
}
