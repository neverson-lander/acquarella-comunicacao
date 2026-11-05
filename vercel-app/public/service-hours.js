import {defaultServiceHours,dayNames,periodNames,withinServiceHours} from './service-hours-policy.mjs';

export function serviceHoursSummary(account,time=Date.now()){
  const hours=account.service_hours;
  return hours?.enabled?(withinServiceHours(hours,time)?'Dentro do horário de atendimento':'Fora do horário de atendimento')+' · '+hours.timezone:'Grade de atendimento desativada';
}
export function showServiceHours(account,{accounts,teamPhone,modal,api,esc}){
  const hours=account.service_hours||defaultServiceHours(),order=[1,2,3,4,5,6,0];
  const zones=[...new Set(['America/Sao_Paulo','America/Manaus','America/Cuiaba','America/Campo_Grande','America/Porto_Velho','America/Boa_Vista','America/Rio_Branco','America/Noronha','America/Bahia','America/Belem','America/Fortaleza','UTC',hours.timezone])];
  const slotHtml=(day,slot,index)=>`<div class="service-hours-slot"><label><span>Início</span><input type="time" required data-start aria-label="Início ${dayNames[day]} intervalo ${index+1}" value="${esc(slot.start)}"></label><span aria-hidden="true">até</span><label><span>Fim</span><input type="text" inputmode="numeric" required pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" maxlength="5" data-end aria-label="Fim ${dayNames[day]} intervalo ${index+1}" value="${esc(slot.end)}" placeholder="18:00"></label><button type="button" class="secondary" data-remove-slot aria-label="Remover intervalo de ${dayNames[day]}">Remover</button></div>`;
  modal('Horários e encaminhamento',`
    <div class="service-hours-tabs" role="tablist" aria-label="Configuração de horários e encaminhamento"><button type="button" role="tab" id="hours-tab-week" data-hours-tab="week" aria-controls="hours-week" aria-selected="true">Horários de atendimento</button><button type="button" role="tab" id="hours-tab-routing" data-hours-tab="routing" aria-controls="hours-routing" aria-selected="false" tabindex="-1">Encaminhamento</button></div>
    <div class="alert-form-body"><p class="alert-channel-context">Canal: <strong>${esc(account.name)}</strong></p>
    <section id="hours-week" class="service-hours-editor" role="tabpanel" aria-labelledby="hours-tab-week">
      <div class="alert-section"><label class="alert-enable-row"><span><strong>Usar grade de atendimento</strong><small>Defina os dias e horários de funcionamento deste canal.</small></span><input name="hoursEnabled" type="checkbox" role="switch" ${hours.enabled?'checked':''}></label>
      <label class="alert-sender">Fuso horário<select name="hoursTimezone">${zones.map(zone=>`<option ${zone===hours.timezone?'selected':''} value="${esc(zone)}">${esc(zone)}</option>`).join('')}</select></label>
      <details class="alert-delivery-help"><summary>Como configurar os intervalos</summary><p>Dias sem intervalos ficam fora do atendimento. Para o dia inteiro, use 00:00 até 24:00. Se o fim for anterior ao início, o intervalo termina no dia seguinte. Adicione até quatro intervalos por dia.</p></details></div>
      <div class="service-hours-week-heading"><h3>Grade semanal</h3><button type="button" class="secondary" data-copy-weekdays>Copiar segunda para terça a sexta</button></div><p class="service-hours-feedback" role="status"></p>
      ${order.map((day,index)=>`<details class="service-hours-day" data-hours-day="${day}" ${index===0?'open':''}><summary><strong>${dayNames[day]}</strong><span data-day-summary></span></summary><div class="service-hours-day-body"><div data-slots>${hours.days[day].map((s,i)=>slotHtml(day,s,i)).join('')}</div><p class="field-note service-hours-closed" data-closed ${hours.days[day].length?'hidden':''}>Sem atendimento neste dia.</p><button type="button" class="secondary" data-add-slot>+ Adicionar intervalo</button></div></details>`).join('')}
    </section>
    <section id="hours-routing" class="service-hours-routing" role="tabpanel" aria-labelledby="hours-tab-routing" hidden><div class="alert-section">
      <label class="alert-enable-row"><span><strong>Encaminhar ao WhatsApp</strong><small>Envie as mensagens deste canal para o WhatsApp da equipe.</small></span><input type="checkbox" role="switch" name="forwardingEnabled" ${account.forwarding_enabled&&(account.bridge||(account.channel==='whatsapp'&&account.forwarding_phone))?'checked':''}></label>
      <div class="service-hours-route-fields">
      <label>Conta WhatsApp que fará o envio<select name="bridge"><option value="">${account.channel==='whatsapp'?'Usar este canal WhatsApp':'Selecione uma conta WhatsApp'}</option>${accounts.filter(a=>!a.deleted_at&&a.channel==='whatsapp'&&a.id!==account.id).map(a=>`<option value="${a.id}" ${account.bridge===a.id?'selected':''}>${esc(a.name)}${a.mode==='live'?'':' · demonstração'}</option>`).join('')}</select></label>
      <label>Telefone WhatsApp de destino<input name="forwardingPhone" type="tel" autocomplete="off" value="${esc(account.forwarding_phone||teamPhone||'')}" placeholder="55 + DDD + número"></label>
      <label>Quando encaminhar<select name="forwardingPeriod">${Object.entries(periodNames).map(([value,label])=>`<option value="${value}" ${(account.forwarding_period||'always')===value?'selected':''}>${label}</option>`).join('')}</select></label>
      </div><div class="alert-background-note">As mensagens continuam disponíveis na central. A conta de envio também é usada pelos alertas configurados neste canal.</div><details class="alert-delivery-help"><summary>Como funciona o encaminhamento</summary><p>O destino pode responder ao cliente usando “Responder” e citando o encaminhamento. Essa resposta continua permitida após a mudança de horário, enquanto o encaminhamento estiver ativo. A API oficial exige uma janela de 24 horas aberta com o destino; o canal por QR Code usa o aparelho vinculado.</p></details>
    </div></section></div>`,async form=>{
      const days=Array.from({length:7},()=>[]);
      document.querySelectorAll('#modal-form [data-hours-day]').forEach(field=>{days[Number(field.dataset.hoursDay)]=[...field.querySelectorAll('.service-hours-slot')].map(row=>({start:row.querySelector('[data-start]').value,end:row.querySelector('[data-end]').value}));});
      return api('accounts/'+account.id+'/service-hours',{serviceHours:{enabled:form.has('hoursEnabled'),timezone:form.get('hoursTimezone'),days},forwardingEnabled:form.has('forwardingEnabled'),forwardingPhone:form.get('forwardingPhone'),forwardingPeriod:form.get('forwardingPeriod'),bridge:form.get('bridge')});
    });
  const form=document.querySelector('#modal-form'),dialog=document.querySelector('#modal');dialog.classList.add('alert-config-dialog','hours-config-dialog');form.querySelector('.primary').textContent='Salvar configurações';
  dialog.addEventListener('close',()=>{if(!dialog.open)dialog.classList.remove('alert-config-dialog','hours-config-dialog');},{once:true});
  const tabs=[...form.querySelectorAll('[data-hours-tab]')],selectTab=tab=>{for(const button of tabs){const active=button===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;form.querySelector('#'+button.getAttribute('aria-controls')).hidden=!active;}};
  for(const tab of tabs){tab.onclick=()=>selectTab(tab);tab.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const index=tabs.indexOf(tab),next=e.key==='Home'?tabs[0]:e.key==='End'?tabs.at(-1):tabs[(index+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length];selectTab(next);next.focus();};}
  form.addEventListener('invalid',event=>{const panel=event.target.closest('[role=tabpanel]');if(panel)selectTab(tabs.find(t=>t.getAttribute('aria-controls')===panel.id));const day=event.target.closest('[data-hours-day]');if(day)day.open=true;},true);
  const update=field=>{const rows=[...field.querySelectorAll('.service-hours-slot')],count=rows.length;field.querySelector('[data-closed]').hidden=count>0;field.querySelector('[data-add-slot]').disabled=count>=4;const summary=field.querySelector('[data-day-summary]');summary.textContent=count?rows.map(row=>row.querySelector('[data-start]').value+' – '+row.querySelector('[data-end]').value).join(' · '):'Sem atendimento';summary.classList.toggle('is-closed',!count);rows.forEach((row,index)=>{row.querySelector('[data-start]').setAttribute('aria-label','Início '+dayNames[field.dataset.hoursDay]+' intervalo '+(index+1));row.querySelector('[data-end]').setAttribute('aria-label','Fim '+dayNames[field.dataset.hoursDay]+' intervalo '+(index+1));});};
  form.addEventListener('input',event=>{const field=event.target.closest('[data-hours-day]');if(field)update(field);});
  form.addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-slot]'),add=event.target.closest('[data-add-slot]');
    if(remove){const field=remove.closest('[data-hours-day]');remove.closest('.service-hours-slot').remove();update(field);}
    if(add){const field=add.closest('[data-hours-day]'),count=field.querySelectorAll('.service-hours-slot').length;if(count<4){field.querySelector('[data-slots]').insertAdjacentHTML('beforeend',slotHtml(Number(field.dataset.hoursDay),{start:'09:00',end:'18:00'},count));field.open=true;update(field);field.querySelector('.service-hours-slot:last-child [data-start]').focus();}}
    if(event.target.closest('[data-copy-weekdays]')){
      const source=[...form.querySelectorAll('[data-hours-day="1"] .service-hours-slot')].map(row=>({start:row.querySelector('[data-start]').value,end:row.querySelector('[data-end]').value}));
      for(const day of [2,3,4,5]){const field=form.querySelector(`[data-hours-day="${day}"]`);field.querySelector('[data-slots]').innerHTML=source.map((s,i)=>slotHtml(day,s,i)).join('');update(field);}
      form.querySelector('.service-hours-feedback').textContent='Horários de segunda copiados para terça a sexta. Salve para aplicar.';
    }
  });
  form.querySelectorAll('[data-hours-day]').forEach(update);
}
