const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const row=phone=>`<div class="alert-phone-row"><label>Telefone com código do país<input name="alertPhone" type="tel" inputmode="tel" autocomplete="off" maxlength="32" value="${esc(phone)}" placeholder="+55 34 99999-9999"></label><button type="button" class="secondary" data-remove-alert-phone aria-label="Remover telefone">Remover</button></div>`;
export function alertPhoneFields(phones=[]){return `<div class="alert-phone-editor"><h3>Telefones que receberão os alertas deste canal</h3><div data-alert-phone-list>${phones.map(row).join('')}</div><button type="button" class="secondary" data-add-alert-phone>Adicionar telefone</button><p class="field-note">Cadastre cada telefone individualmente, com código do país e DDD. Até 20 números por canal. Cada destinatário precisa enviar uma mensagem ao número WhatsApp da API para abrir sua janela de 24 horas. Falhas de um número não impedem os demais envios. Se o remetente for um número de teste da Meta, cada telefone também precisa ser adicionado e confirmado na lista de destinatários de teste, em Meta Developers → WhatsApp → Configuração da API.</p></div>`;}
export function bindAlertPhones(form){
  const list=form.querySelector('[data-alert-phone-list]'),add=form.querySelector('[data-add-alert-phone]');
  if(!list)return;
  const update=()=>{add.disabled=list.children.length>=20;};
  add.onclick=()=>{list.insertAdjacentHTML('beforeend',row(''));list.lastElementChild.querySelector('input').focus();update();};
  list.onclick=e=>{const button=e.target.closest('[data-remove-alert-phone]');if(button){button.closest('.alert-phone-row').remove();update();}};
  update();
}
export const alertPhonesFromForm=form=>form.getAll('alertPhone').map(phone=>phone.trim()).filter(Boolean);
