import {withFeedback} from './action-feedback.js';
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=x=>x?new Date(Number(x)).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Ainda não executado';
const states={discovering:'Consultando registros',executing:'Processando',complete:'Concluído',cancelled:'Cancelado',pending:'Pendente',sending:'Em processamento',closed:'Fechada',skipped:'Sem ação necessária',failed:'Falha',uncertain:'Conferir no CashBarber'};
export function mountDailyActions(container,{api,getState}){
 if(getState().user.role!=='admin')return;
 const section=document.createElement('section');section.className='panel';
 section.innerHTML=`<h3>Rotinas diárias do CashBarber</h3><p>Horários de Brasília. Cada rotina começa uma vez ao dia e conclui os registros em lotes. Se ativada depois do horário, começa no dia seguinte. Ambas vêm desligadas. Desligar interrompe as próximas ações; uma operação já iniciada pode concluir.</p>
 <form data-feature="subscriptions"><h4>Lembretes de assinatura · 8h</h4><p>Assinaturas manuais: aviso 3 dias antes e no dia do vencimento, conforme o dia de cobrança. Usa a conexão exclusiva da automação acima. Em meses mais curtos, o vencimento fica no último dia do mês. Consulte os envios em Ações ativas, tipo Assinatura.</p><label class="cash-check"><input type="checkbox" name="enabled"> Ativar lembretes de assinatura</label><label>WhatsApp de envio<select name="account"><option value="">Selecione</option></select></label><button type="submit" class="primary">Salvar assinaturas</button><p data-status role="status"></p></form>
 <hr><form data-feature="comandas"><h4>Fechamento de comandas · 7h</h4><p>Inclui todas as comandas abertas há mais de 72 horas na filial da automação, inclusive com saldo pendente. No CashBarber, fechar registra o pagamento do saldo. Escolha o caixa e a forma de pagamento que devem receber esses lançamentos.</p><label class="cash-check"><input type="checkbox" name="enabled"> Ativar fechamento diário de comandas</label><button type="button" class="secondary" data-options>Consultar caixas e formas de pagamento</button><label>Caixa<select name="cashbox"><option value="">Selecione</option></select></label><label>Forma de pagamento<select name="payment_method"><option value="">Selecione</option></select></label><label class="cash-check"><input type="checkbox" name="acknowledge"> Estou ciente de que o fechamento registra pagamento dos saldos pendentes no caixa selecionado.</label><button type="submit" class="primary">Salvar fechamento de comandas</button><button type="button" class="secondary" data-run-comandas disabled>Forçar fechamento agora</button><p data-status role="status"></p></form><details><summary>Histórico das rotinas e comandas</summary><div data-history></div></details>`;
 container.append(section);let data;
 const forms=[...section.querySelectorAll('form')],call=input=>api('cashbarber/daily-actions',input);
 const sub=forms[0],closing=forms[1],runClosing=closing.querySelector('[data-run-comandas]');
 for(const a of getState().accounts.filter(a=>a.channel==='whatsapp'&&a.transport==='qr'&&a.enabled!==false&&!a.deleted_at&&a.mode==='live'))sub.elements.account.insertAdjacentHTML('beforeend',`<option value="${esc(a.id)}">${esc(a.name)}</option>`);
 function display(result){
  data=result;
  for(const form of forms){const config=data.settings.find(s=>s.feature===form.dataset.feature);form.elements.enabled.checked=config?.enabled===true;
   for(const field of ['account','cashbox','payment_method'])if(form.elements[field]){const value=config?.[field]||'',select=form.elements[field];if(value&&![...select.options].some(o=>o.value===value))select.insertAdjacentHTML('beforeend',`<option value="${esc(value)}">ID ${esc(value)} (consulte para atualizar)</option>`);select.value=value;}
   form.querySelector('[data-status]').textContent=(config?.enabled?'Ligada. ':'Desligada. ')+'Última conclusão: '+stamp(config?.last_run)+(config?.error?' · '+config.error:'');
  }
  runClosing.disabled=!data.settings.find(s=>s.feature==='comandas')?.enabled;
  section.querySelector('[data-history]').innerHTML=`<ul>${data.runs.map(r=>`<li>${esc(r.day)} · ${r.feature==='subscriptions'?'Assinaturas':'Comandas'} · ${esc(states[r.state]||r.state)}${r.feature==='comandas'?` · ${r.closed} fechada(s), ${r.attention} para conferência`:''}</li>`).join('')}</ul><ul>${data.items.map(i=>`<li>Comanda ${esc(i.external_id)} · ${esc(states[i.state]||i.state)} · ${esc(stamp(i.updated))}${i.error?' · '+esc(i.error):''}</li>`).join('')}</ul>`;
 }
 for(const form of forms)form.onsubmit=async event=>{
  event.preventDefault();
  try{
   const fields=form===sub?{account:form.elements.account.value}:{cashbox:form.elements.cashbox.value,payment_method:form.elements.payment_method.value,acknowledge:form.elements.acknowledge.checked};
   const result=await withFeedback(event.submitter,'Salvando…',()=>call({save:true,feature:form.dataset.feature,enabled:form.elements.enabled.checked,...fields}),form);
   if(!result)return;
   display(result);
   if(form===closing)form.elements.acknowledge.checked=false;
  }catch(error){form.querySelector('[data-status]').textContent=error.message;}
 };
 runClosing.onclick=async()=>{
  if(!window.confirm('Fechar agora as comandas elegíveis? O CashBarber registrará os saldos pendentes no caixa e na forma de pagamento salvos.'))return;
  const status=closing.querySelector('[data-status]');
  try{
   const result=await withFeedback(runClosing,'Iniciando fechamento…',()=>call({action:'run-comandas',confirm:true}),closing);
   display(result);
   const run=result.runs.find(r=>r.feature==='comandas');
   status.textContent+=run?.state==='complete'?' Fechamento concluído.':' Fechamento iniciado. Acompanhe o histórico para ver a conclusão.';
   section.querySelector('details').open=true;
  }catch(error){status.textContent=error.message;}
 };
 section.querySelector('[data-options]').onclick=async event=>{try{await withFeedback(event.currentTarget,'Consultando…',async()=>{const options=await call({action:'options'});for(const [field,items]of [['cashbox',options.boxes],['payment_method',options.methods]]){const select=closing.elements[field],value=select.value;select.innerHTML='<option value="">Selecione</option>'+items.map(i=>`<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('');select.value=value;}},closing);}catch(e){closing.querySelector('[data-status]').textContent=e.message;}};
 call({}).then(display).catch(e=>{for(const form of forms)form.querySelector('[data-status]').textContent=e.message;});
}
