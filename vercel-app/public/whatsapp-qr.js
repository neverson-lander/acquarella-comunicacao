import {action} from './action-feedback.js';

export function showWhatsAppQr(account,{api,esc}) {
  document.querySelector('#whatsapp-qr-dialog')?.close();
  const dialog=document.createElement('dialog');dialog.id='whatsapp-qr-dialog';dialog.className='qr-dialog';
  dialog.innerHTML=`<div class="modal-heading"><h2>WhatsApp por QR Code · ${esc(account.name)}</h2><button type="button" data-qr-close aria-label="Fechar">×</button></div>
    <p>No WhatsApp do celular, abra <strong>Aparelhos conectados → Conectar um aparelho</strong> e escaneie o código.</p>
    <p data-qr-status role="status">Consultando conexão…</p><img data-qr-image hidden width="280" height="280" alt="QR Code para conectar o WhatsApp">
    <p class="field-note">A conexão usa um aparelho vinculado. Se a sessão for encerrada, reconecte aqui. Os envios deste canal não aparecem nas métricas da API oficial da Meta.</p>
    <p data-qr-error class="form-error" role="alert"></p><div class="modal-footer"><button type="button" class="secondary" data-qr-disconnect>Desconectar</button><button type="button" class="primary" data-qr-connect>Conectar / gerar QR Code</button></div>`;
  document.body.append(dialog);dialog.showModal();
  const image=dialog.querySelector('[data-qr-image]'),status=dialog.querySelector('[data-qr-status]'),error=dialog.querySelector('[data-qr-error]');
  const connect=dialog.querySelector('[data-qr-connect]'),disconnect=dialog.querySelector('[data-qr-disconnect]');
  let timer,busy=false,disposed=false,latest=null;
  function render(result){
    latest=result;
    const labels={connected:'Conectado',connecting:'Iniciando conexão…',qr:'Aguardando leitura do QR Code',reconnecting:'Reconectando…',disconnected:'Desconectado',replaced:'Sessão encerrada em outro dispositivo. Conecte novamente.',unavailable:'Serviço indisponível'};
    status.textContent=(labels[result.status]||'Desconectado')+(result.phone?' · +'+result.phone:'');
    const qr=typeof result.qr==='string'&&/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(result.qr)&&result.qrExpiresAt>Date.now()?result.qr:'';
    image.hidden=!qr;if(qr)image.src=qr;else image.removeAttribute('src');
    connect.disabled=result.connected||['connecting','reconnecting'].includes(result.status);
    disconnect.disabled=result.status==='disconnected';
  }
  async function update(operation){
    if(disposed||busy)return;busy=true;error.textContent='';
    try{const result=await api(`accounts/${account.id}/qr${operation?'/'+operation:''}`,operation?{}:undefined);if(!disposed)render(result);}
    catch(e){if(!disposed){error.textContent=e.message;image.hidden=true;image.removeAttribute('src');connect.disabled=false;}}
    finally{busy=false;if(!disposed){clearTimeout(timer);timer=setTimeout(()=>update(),3000);}}
  }
  const perform=(operation,label)=>async event=>{await action(()=>update(operation),label)(event);if(!disposed&&latest)render(latest);};
  connect.onclick=perform('connect','Iniciando conexão…');
  disconnect.onclick=perform('disconnect','Desconectando…');
  dialog.querySelector('[data-qr-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{disposed=true;clearTimeout(timer);image.removeAttribute('src');dialog.remove();},{once:true});
  update();
}
