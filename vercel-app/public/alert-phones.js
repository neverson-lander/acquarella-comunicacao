const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const row=phone=>`<div class="alert-phone-row"><label>Telefone com DDI e DDD<input name="alertPhone" type="tel" inputmode="tel" autocomplete="off" maxlength="32" value="${esc(phone)}" placeholder="+55 34 99999-9999"></label><button type="button" class="secondary" data-remove-alert-phone aria-label="Remover telefone">Remover</button></div>`;
export function alertPhoneFields(phones=[]){return `<div class="alert-phone-editor"><div class="alert-section-heading"><h3>Quem recebe os alertas</h3><span data-alert-phone-count class="alert-phone-count">${phones.length} / 20</span></div><p class="alert-section-description">Adicione os telefones da equipe que devem ser avisados.</p><div data-alert-phone-list>${phones.map(row).join('')}</div><p class="alert-phone-empty" data-alert-phone-empty ${phones.length?'hidden':''}>Nenhum telefone adicionado.</p><button type="button" class="secondary" data-add-alert-phone>+ Adicionar telefone</button><details class="alert-delivery-help"><summary>Regras de envio pela API oficial do WhatsApp</summary><p>Cada destinatário precisa enviar uma mensagem ao número da API para abrir a janela de 24 horas. Falhas de um número não impedem os demais envios.</p><p>Se o remetente for um número de teste da Meta, adicione e confirme cada telefone em Meta Developers → WhatsApp → Configuração da API.</p></details></div>`;}
export function bindAlertPhones(form){
  const list=form.querySelector('[data-alert-phone-list]'),add=form.querySelector('[data-add-alert-phone]');
  if(!list)return;
  const update=()=>{const count=list.children.length;add.disabled=count>=20;const counter=form.querySelector('[data-alert-phone-count]'),empty=form.querySelector('[data-alert-phone-empty]');if(counter)counter.textContent=count+' / 20';if(empty)empty.hidden=count>0;};
  add.onclick=()=>{list.insertAdjacentHTML('beforeend',row(''));list.lastElementChild.querySelector('input').focus();update();};
  list.onclick=e=>{const button=e.target.closest('[data-remove-alert-phone]');if(button){button.closest('.alert-phone-row').remove();update();}};
  update();
}
export const alertPhonesFromForm=form=>form.getAll('alertPhone').map(phone=>phone.trim()).filter(Boolean);
