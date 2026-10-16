import {defaultServiceHours,dayNames,periodNames,withinServiceHours} from './service-hours-policy.mjs';

export function serviceHoursSummary(account,time=Date.now()){
  const hours=account.service_hours;
  return hours?.enabled?(withinServiceHours(hours,time)?'Dentro do horário de atendimento':'Fora do horário de atendimento')+' · '+hours.timezone:'Grade de atendimento desativada';
}
export function showServiceHours(account,{accounts,teamPhone,modal,api,esc}){
  const hours=account.service_hours||defaultServiceHours(),order=[1,2,3,4,5,6,0];
  const zones=[...new Set(['America/Sao_Paulo','America/Manaus','America/Cuiaba','America/Campo_Grande','America/Porto_Velho','America/Boa_Vista','America/Rio_Branco','America/Noronha','America/Bahia','America/Belem','America/Fortaleza','UTC',hours.timezone])];
  const slotHtml=(day,slot,index)=>`<div class="service-hours-slot"><label><span>Início</span><input type="time" required data-start aria-label="Início ${dayNames[day]} intervalo ${index+1}" value="${esc(slot.start)}"></label><span aria-hidden="true">até</span><label><span>Fim</span><input type="text" inputmode="numeric" required pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" maxlength="5" data-end aria-label="Fim ${dayNames[day]} intervalo ${index+1}" value="${esc(slot.end)}" placeholder="18:00"></label><button type="button" class="secondary" data-remove-slot aria-label="Remover intervalo de ${dayNames[day]}">Remover</button></div>`;
  modal('Horários e encaminhamento · '+esc(account.name),`
    <section class="service-hours-editor" aria-label="Grade semanal de atendimento">
      <label class="toggle-row"><span>Usar grade de atendimento neste canal</span><input name="hoursEnabled" type="checkbox" role="switch" ${hours.enabled?'checked':''}></label>
      <label>Fuso horário<select name="hoursTimezone">${zones.map(zone=>`<option ${zone===hours.timezone?'selected':''} value="${esc(zone)}">${esc(zone)}</option>`).join('')}</select></label>
      <p class="field-note">Dias sem intervalos ficam fora do atendimento. Para o dia inteiro, use 00:00 até 24:00. Se o fim for anterior ao início, o intervalo termina no dia seguinte.</p>
      ${order.map(day=>`<fieldset data-hours-day="${day}"><legend>${dayNames[day]}</legend><div data-slots>${hours.days[day].map((s,i)=>slotHtml(day,s,i)).join('')}</div><p class="field-note" data-closed ${hours.days[day].length?'hidden':''}>Sem atendimento neste dia.</p><button type="button" class="secondary" data-add-slot>Adicionar intervalo</button></fieldset>`).join('')}
      <button type="button" class="secondary" data-copy-weekdays>Copiar segunda para terça a sexta</button>
    </section>
    <section class="service-hours-routing" aria-label="Encaminhamento por WhatsApp"><h3>Encaminhar mensagens para um WhatsApp</h3>
      <label class="toggle-row"><span>Ativar encaminhamento neste canal</span><input type="checkbox" role="switch" name="forwardingEnabled" ${account.forwarding_enabled&&(account.bridge||(account.channel==='whatsapp'&&account.forwarding_phone))?'checked':''}></label>
      <label>Conta WhatsApp que fará o envio<select name="bridge"><option value="">${account.channel==='whatsapp'?'Usar este canal WhatsApp':'Selecione uma conta WhatsApp'}</option>${accounts.filter(a=>a.channel==='whatsapp'&&a.id!==account.id).map(a=>`<option value="${a.id}" ${account.bridge===a.id?'selected':''}>${esc(a.name)}${a.mode==='live'?'':' · demonstração'}</option>`).join('')}</select></label>
      <label>Telefone WhatsApp de destino<input name="forwardingPhone" type="tel" autocomplete="off" value="${esc(account.forwarding_phone||teamPhone||'')}" placeholder="55 + DDD + número"></label>
      <label>Quando encaminhar<select name="forwardingPeriod">${Object.entries(periodNames).map(([value,label])=>`<option value="${value}" ${(account.forwarding_period||'always')===value?'selected':''}>${label}</option>`).join('')}</select></label>
      <p class="field-note">A mensagem continua na central. O destino pode responder ao cliente usando “Responder” e citando o encaminhamento. Essa resposta continua permitida após a mudança de horário, enquanto o encaminhamento estiver ativo. A API oficial exige uma janela de 24 horas aberta com o destino; o canal por QR Code usa o aparelho vinculado. Esta seleção de conta também é usada pelos alertas já configurados neste canal.</p>
    </section>`,async form=>{
      const days=Array.from({length:7},()=>[]);
      document.querySelectorAll('#modal-form [data-hours-day]').forEach(field=>{days[Number(field.dataset.hoursDay)]=[...field.querySelectorAll('.service-hours-slot')].map(row=>({start:row.querySelector('[data-start]').value,end:row.querySelector('[data-end]').value}));});
      return api('accounts/'+account.id+'/service-hours',{serviceHours:{enabled:form.has('hoursEnabled'),timezone:form.get('hoursTimezone'),days},forwardingEnabled:form.has('forwardingEnabled'),forwardingPhone:form.get('forwardingPhone'),forwardingPeriod:form.get('forwardingPeriod'),bridge:form.get('bridge')});
    });
  const form=document.querySelector('#modal-form');
  const update=field=>{const count=field.querySelectorAll('.service-hours-slot').length;field.querySelector('[data-closed]').hidden=count>0;field.querySelector('[data-add-slot]').disabled=count>=4;};
  form.addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-slot]'),add=event.target.closest('[data-add-slot]');
    if(remove){const field=remove.closest('[data-hours-day]');remove.closest('.service-hours-slot').remove();update(field);}
    if(add){const field=add.closest('[data-hours-day]'),count=field.querySelectorAll('.service-hours-slot').length;if(count<4){field.querySelector('[data-slots]').insertAdjacentHTML('beforeend',slotHtml(Number(field.dataset.hoursDay),{start:'09:00',end:'18:00'},count));update(field);}}
    if(event.target.closest('[data-copy-weekdays]')){
      const source=[...form.querySelectorAll('[data-hours-day="1"] .service-hours-slot')].map(row=>({start:row.querySelector('[data-start]').value,end:row.querySelector('[data-end]').value}));
      for(const day of [2,3,4,5]){const field=form.querySelector(`[data-hours-day="${day}"]`);field.querySelector('[data-slots]').innerHTML=source.map((s,i)=>slotHtml(day,s,i)).join('');update(field);}
    }
  });
  form.querySelectorAll('[data-hours-day]').forEach(update);
}
