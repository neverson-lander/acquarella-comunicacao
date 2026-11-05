import {withFeedback} from './action-feedback.js';

export function mountMercadoPagoSettings(container,{api,getState}){
  if(getState().user.role!=='admin')return;
  const section=document.createElement('section');
  section.className='panel';
  section.innerHTML=`<h3>Mercado Pago</h3>
    <p>Configure o Checkout Pro para as renovações de assinatura. O link usa o valor da assinatura no CashBarber. Com a opção desligada, os lembretes seguem com a mensagem padrão.</p>
    <form autocomplete="off">
      <fieldset disabled>
        <legend>Credenciais do Checkout Pro</legend>
        <label>Ambiente<select name="environment"><option value="production">Produção</option><option value="test">Teste</option></select></label>
        <label>Access Token<input name="accessToken" type="password" autocomplete="new-password" maxlength="2048" spellcheck="false"></label>
        <label>Segredo do webhook<input name="webhookSecret" type="password" autocomplete="new-password" maxlength="2048" spellcheck="false"></label>
        <label class="cash-check" data-link-option hidden><input name="linksEnabled" type="checkbox"> Enviar link de pagamento nos lembretes de assinatura</label>
        <p class="field-note" data-credentials>Consultando credenciais…</p>
        <p class="field-note">Deixe um campo em branco para manter a credencial salva no ambiente selecionado.</p>
        <button class="primary" type="submit">Salvar configurações do Mercado Pago</button>
        <button class="secondary" type="button" data-sample>Gerar amostra de mensagens</button>
        <p class="field-note">A amostra consulta o CashBarber, usa o Access Token salvo em Teste e exibe as mensagens aqui, sem envio pelo WhatsApp.</p>
      </fieldset>
      <p role="status"></p>
      <div data-samples></div>
    </form>`;
  container.append(section);
  const form=section.querySelector('form'),fields=form.querySelector('fieldset'),status=form.querySelector('[role="status"]');
  const {environment,accessToken,webhookSecret,linksEnabled}=form.elements;
  const sampleButton=form.querySelector('[data-sample]'),samples=form.querySelector('[data-samples]');
  let environments=[];
  const call=input=>api('mercado-pago/settings',input);
  function display(){
    const selected=environments.find(item=>item.environment===environment.value);
    form.querySelector('[data-link-option]').hidden=environment.value!=='production';
    linksEnabled.checked=selected?.links_enabled===true;
    const saved=value=>value?'salvo':'não configurado';
    form.querySelector('[data-credentials]').textContent=
      `Access Token: ${saved(selected?.has_token)} · Segredo do webhook: ${saved(selected?.has_webhook_secret)}`;
    accessToken.value='';
    webhookSecret.value='';
  }
  environment.onchange=()=>{display();status.textContent='';};
  sampleButton.onclick=async()=>{
    fields.disabled=true;
    samples.replaceChildren();
    status.textContent='';
    try{
      const result=await withFeedback(sampleButton,'Gerando amostra…',()=>call({action:'sample'}),form);
      for(const message of result.messages){
        const card=document.createElement('article'),heading=document.createElement('h4'),body=document.createElement('p'),link=document.createElement('a');
        heading.textContent=`${message.name} · ${message.notice==='due'?'No vencimento':'3 dias antes'}`;
        body.style.whiteSpace='pre-wrap';
        body.textContent=message.body;
        link.href=message.url;
        link.target='_blank';
        link.rel='noopener noreferrer';
        link.textContent='Abrir checkout de teste';
        card.append(heading,body,link);
        samples.append(card);
      }
      for(const error of result.errors){
        const note=document.createElement('p');
        note.textContent=`${error.date.split('-').reverse().join('/')} · ${error.message}`;
        samples.append(note);
      }
      status.textContent=result.messages.length?'Amostra gerada. Nenhuma mensagem foi enviada.':'Nenhuma mensagem pôde ser gerada para os vencimentos consultados.';
    }catch(error){
      status.textContent=error.message;
    }finally{
      fields.disabled=false;
    }
  };
  form.onsubmit=async event=>{
    event.preventDefault();
    const input={action:'save',environment:environment.value,accessToken:accessToken.value.trim(),webhookSecret:webhookSecret.value.trim()};
    if(environment.value==='production')input.linksEnabled=linksEnabled.checked;
    fields.disabled=true;
    status.textContent='';
    try{
      const result=await withFeedback(event.submitter,'Salvando…',()=>call(input),form);
      environments=result.environments;
      display();
      status.textContent='Configurações salvas.';
    }catch(error){
      status.textContent=error.message;
    }finally{
      fields.disabled=false;
    }
  };
  call({}).then(result=>{
    environments=result.environments;
    display();
    fields.disabled=false;
  }).catch(error=>{status.textContent=error.message;});
}
