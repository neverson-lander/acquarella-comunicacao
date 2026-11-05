import {withFeedback} from './action-feedback.js';
import {mountDailyActions} from './daily-actions.js?v=20261104';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=value=>value?new Date(Number(value)).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'Ainda não executado';
const states={pending:'Programado',sending:'Enviando',sent:'Enviado',failed:'Falha',uncertain:'Entrega não confirmada',cancelled:'Cancelado',expired:'Horário ultrapassado'};
export function mountAppointmentNotifications(container,{api,getState,configure}){
  if(getState().user.role!=='admin')return;
  const section=document.createElement('section');section.className='panel appointment-notifications';
  section.innerHTML='<h3>Conexão e consulta da agenda</h3><p>A consulta prepara apenas lembretes para os atendimentos de hoje e confirmações para os de amanhã, com envio previsto 2 e 24 horas antes, respectivamente. Reservas feitas com menos de 24 horas recebem só o lembrete; reservas feitas no mesmo dia não recebem mensagens. Sem resposta, a reserva é mantida e o lembrete segue normalmente.</p><form><label class="cash-check"><input name="enabled" type="checkbox"> Consultar agenda automaticamente</label><label class="cash-check"><input name="automatic" type="checkbox" disabled> Enviar mensagens automaticamente</label><label>WhatsApp de envio<select name="account"><option value="">Selecione</option></select></label><p class="field-note">Disponível para WhatsApp conectado por QR. Conecte a conta exclusiva da automação nesta seção. Clientes ausentes serão cadastrados com nome, telefone e e-mail do CashBarber, preservando os cadastros existentes. Horários de Brasília; tolerância de 10 minutos. Com o envio automático ligado, as mensagens elegíveis da fila serão enviadas no horário previsto, sem revisão individual. Ao desligar, a consulta continua e o envio fica manual em Mensagens ativas. Mensagens já em envio podem ser concluídas. Envios permitidos a partir das 8h.</p><button class="primary" type="submit">Salvar configurações da agenda</button><button class="secondary" type="button" data-refresh>Atualizar configuração</button></form><p role="status" data-status></p><p class="field-note">Gerencie a fila, filtros, prévias e cancelamentos no menu <strong>Mensagens ativas</strong>.</p>';
  container.append(section);const form=section.querySelector('form'),status=section.querySelector('[data-status]');
  const connection=document.createElement('div');connection.innerHTML='<h4>Conexão exclusiva da automação</h4><p>Conta usada para consultar a agenda e executar as rotinas diárias habilitadas abaixo. As telas continuam usando a conta pessoal de cada operador.</p><button class="secondary" type="button" data-service-connect>Conectar conta da automação</button><button class="secondary" type="button" data-service-disconnect>Desconectar automação</button><p data-service-status role="status"></p>';
  form.before(connection);
  const serviceStatus=connection.querySelector('[data-service-status]');
  async function refreshConnection(){const result=await api('cashbarber/notification-connection',{action:'status'});serviceStatus.textContent=result.connected?'Automação conectada. Renovação automática habilitada.':'Automação desconectada. Conecte uma conta exclusiva para as mensagens.';}
  connection.querySelector('[data-service-connect]').onclick=()=>configure({onConnected:refreshConnection});
  connection.querySelector('[data-service-disconnect]').onclick=async event=>{try{await withFeedback(event.currentTarget,'Desconectando…',()=>api('cashbarber/notification-connection',{action:'disconnect'}));await refreshConnection();}catch(e){serviceStatus.textContent=e.message;}};
  refreshConnection().catch(e=>{serviceStatus.textContent=e.message;});
  for(const a of getState().accounts.filter(a=>a.channel==='whatsapp'&&a.transport==='qr'&&a.enabled!==false&&!a.deleted_at&&a.mode==='live')){const option=document.createElement('option');option.value=a.id;option.textContent=a.name;form.elements.account.append(option);}
  async function load(input={}){
    const data=await api('cashbarber/notifications',input);if(!section.isConnected)return;
    form.elements.enabled.checked=data.settings.enabled;form.elements.account.value=data.settings.account||'';
    form.elements.automatic.checked=data.settings.delivery_mode==='automatic';syncAutomatic();
    status.textContent=(input.save?'Configuração salva. ':'')+(data.settings.enabled&&data.settings.delivery_mode==='automatic'?'Envio automático ligado. ':'Envio automático desligado. ')+'Última verificação: '+stamp(data.settings.last_run)+(data.settings.error?' · '+data.settings.error:'');
  }
  function syncAutomatic(){form.elements.automatic.disabled=!form.elements.enabled.checked;if(!form.elements.enabled.checked)form.elements.automatic.checked=false;}
  form.elements.enabled.onchange=syncAutomatic;
  form.onsubmit=async event=>{event.preventDefault();try{await withFeedback(event.submitter,'Salvando…',()=>load({save:true,enabled:form.elements.enabled.checked,delivery_mode:form.elements.automatic.checked?'automatic':'manual',account:form.elements.account.value}),form);}catch(e){status.textContent=e.message;}};
  section.querySelector('[data-refresh]').onclick=async event=>{try{await withFeedback(event.currentTarget,'Atualizando…',()=>load(),form);}catch(e){status.textContent=e.message;}};
  load().catch(e=>{status.textContent=e.message;});
  mountDailyActions(container,{api,getState});
}
