const testRecipientHelp='Destinatário não autorizado para o número de teste da Meta. Em Meta Developers > WhatsApp > Configuração da API, adicione e confirme este telefone na lista de destinatários de teste. Confira se o número autorizado corresponde ao cadastrado na central.';
export function metaSendError(channel,status,code){
  const base=`Meta recusou o envio (HTTP ${status}, código ${code||'desconhecido'}).`;
  return channel==='whatsapp'&&Number(code)===131030?`${base} ${testRecipientHelp}`:base;
}
export function deliveryErrorMessage(error){
  const value=String(error||'');
  return /código 131030\b/.test(value)&&!value.includes(testRecipientHelp)?`${value} ${testRecipientHelp}`:value;
}
