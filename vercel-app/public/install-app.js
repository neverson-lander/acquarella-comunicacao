let pendingPrompt=null, installed=false;
const standalone=()=>installed||matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
export function installAppMarkup(){
  return `<button type="button" class="install-app-button" data-install-app ${standalone()?'hidden':''}><span aria-hidden="true">↓</span> Instalar aplicativo</button>`;
}
function updateButtons(){document.querySelectorAll('[data-install-app]').forEach(button=>{button.hidden=standalone();});const native=document.querySelector('[data-native-install]');if(native)native.hidden=!pendingPrompt||standalone();}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();pendingPrompt=event;updateButtons();});
window.addEventListener('appinstalled',()=>{installed=true;pendingPrompt=null;updateButtons();const status=document.querySelector('.install-app-status');if(status)status.textContent='O navegador confirmou a instalação. Procure Central Acquarella na tela inicial ou na lista de aplicativos do celular.';});
matchMedia('(display-mode: standalone)').addEventListener('change',updateButtons);

function showInstructions(trigger){
  if(document.querySelector('.install-app-dialog[open]'))return;
  document.querySelector('.install-app-dialog')?.remove();
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const android=/Android/.test(navigator.userAgent);
  const steps=ios?
    '<li>Abra a central no <strong>Safari</strong>.</li><li>Toque em <strong>Compartilhar</strong> no menu do navegador.</li><li>Escolha <strong>Adicionar à Tela de Início</strong>. Se aparecer, ative <strong>Abrir como App da Web</strong>.</li><li>Toque em <strong>Adicionar</strong>.</li>':android?
    '<li>Abra a central no <strong>Chrome</strong>.</li><li>Toque no menu <strong>⋮</strong> do navegador.</li><li>Escolha <strong>Adicionar à tela inicial</strong> ou <strong>Instalar aplicativo</strong>.</li><li>Confirme a instalação.</li>':
    '<li>Abra a central no <strong>Chrome</strong> ou <strong>Edge</strong>.</li><li>Procure o ícone de instalação na barra de endereço ou a opção <strong>Instalar aplicativo</strong> no menu do navegador.</li><li>Confirme a instalação.</li>';
  const dialog=document.createElement('dialog');dialog.className='install-app-dialog';dialog.setAttribute('aria-labelledby','install-app-title');
  dialog.innerHTML=`<div class="install-app-heading"><h2 id="install-app-title">Instalar Central Acquarella</h2><button type="button" aria-label="Fechar instruções de instalação">×</button></div><p>Acesse a central pelo ícone na tela inicial do seu aparelho.</p><p class="install-app-status" role="status">${pendingPrompt?'Toque em Instalar agora e confirme na janela do navegador.':'Use o menu do navegador seguindo os passos abaixo.'}</p><button type="button" class="primary" data-native-install ${pendingPrompt?'':'hidden'}>Instalar agora</button><ol>${steps}</ol><p class="install-app-note">Depois de confirmar, procure Central Acquarella na tela inicial ou na lista de aplicativos. A central precisa de internet para atualizar os atendimentos e enviar mensagens.</p><button type="button" class="secondary" data-install-close>Entendi</button>`;
  dialog.querySelector('.install-app-heading button').onclick=dialog.querySelector('[data-install-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-native-install]').onclick=async event=>{
    const button=event.currentTarget,status=dialog.querySelector('.install-app-status'),prompt=pendingPrompt;
    if(!prompt){status.textContent='Use o menu do navegador seguindo os passos abaixo.';button.hidden=true;return;}
    pendingPrompt=null;button.disabled=true;status.textContent='Confirme a instalação na janela do navegador.';
    try{await prompt.prompt();const choice=await prompt.userChoice;if(!installed)status.textContent=choice.outcome==='accepted'?'Solicitação aceita pelo navegador. Aguarde a instalação e procure Central Acquarella na lista de aplicativos.':'A instalação não foi confirmada. Você pode usar o menu do navegador seguindo os passos abaixo.';}
    catch{status.textContent='O navegador não abriu a confirmação. Use o menu do navegador seguindo os passos abaixo.';}
    finally{button.disabled=false;button.hidden=!pendingPrompt;}
  };
  dialog.addEventListener('close',()=>{dialog.remove();if(trigger.isConnected)trigger.focus();},{once:true});document.body.append(dialog);dialog.showModal();
}
document.addEventListener('click',event=>{
  const trigger=event.target.closest?.('[data-install-app]');if(!trigger||standalone())return;
  showInstructions(trigger);
});
