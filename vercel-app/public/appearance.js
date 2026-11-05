import {appearanceOptions,validAppearance} from './appearance-options.mjs';

export function createAppearance({getState,api,toast}){
  let identity='',saved='original',dialog;
  const apply=value=>{if(value==='original')delete document.documentElement.dataset.appearance;else document.documentElement.dataset.appearance=value;};
  function sync(state){
    const next=state?state.tenant.id+':'+state.user.id:'';
    if(next===identity&&dialog?.open)return;
    identity=next;saved=validAppearance(state?.user.appearance)?state.user.appearance:'original';apply(saved);
  }
  function reset(){dialog?.close();identity='';saved='original';apply(saved);}
  function show(){
    if(dialog?.open)return;
    dialog?.remove();dialog=document.createElement('dialog');dialog.id='appearance-dialog';dialog.setAttribute('aria-labelledby','appearance-title');
    dialog.innerHTML=`<form><div class="appearance-heading"><div><h2 id="appearance-title">Sua aparência</h2><p>Escolha as cores que facilitam seu atendimento.</p></div><button type="button" data-cancel aria-label="Fechar aparência">×</button></div><fieldset class="appearance-options"><legend>Opções de cores</legend>${appearanceOptions.map(option=>`<label class="appearance-option" data-palette="${option.id}"><input type="radio" name="appearance" value="${option.id}" ${saved===option.id?'checked':''}><span class="appearance-sample" aria-hidden="true"><i></i><span><b></b><em></em><b></b></span></span><strong>${option.name}</strong><small>${option.description}</small><span class="appearance-selected" aria-hidden="true">Selecionado ✓</span></label>`).join('')}</fieldset><p class="appearance-note">A mudança aparece na hora para você experimentar. Ao salvar, sua escolha acompanha seu acesso em outros dispositivos.</p><p class="form-error" role="alert"></p><div class="appearance-footer"><button type="button" class="secondary" data-cancel>Cancelar</button><button type="submit" class="primary">Salvar aparência</button></div></form>`;
    document.body.append(dialog);let saving=false;
    dialog.addEventListener('close',()=>apply(saved));
    dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();else apply(saved);});
    dialog.querySelectorAll('[data-cancel]').forEach(button=>button.onclick=()=>{apply(saved);dialog.close();});
    dialog.querySelector('fieldset').onchange=event=>{if(validAppearance(event.target.value))apply(event.target.value);};
    dialog.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(saving)return;saving=true;
      const choice=dialog.querySelector('input:checked').value,session=identity;
      const controls=[...dialog.querySelectorAll('button,input')],button=dialog.querySelector('[type=submit]');controls.forEach(control=>control.disabled=true);button.textContent='Salvando…';dialog.querySelector('.form-error').textContent='';
      try{const result=await api('me/appearance',{theme:choice});if(identity!==session)return;saved=result.theme;const current=getState();if(current)current.user.appearance=saved;dialog.close();toast('Aparência salva.');}
      catch(error){dialog.querySelector('.form-error').textContent=error.message;}
      finally{saving=false;controls.forEach(control=>control.disabled=false);button.textContent='Salvar aparência';}
    };
    dialog.showModal();
  }
  return {sync,reset,show};
}
