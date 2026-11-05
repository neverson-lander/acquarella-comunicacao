const text=value=>typeof value==='string'?value.trim().slice(0,12000):'';
function url(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function button(value){
  let native={};
  if(typeof value?.buttonParamsJson==='string'&&value.buttonParamsJson.length<=16000){try{native=JSON.parse(value.buttonParamsJson)||{};}catch{}}
  const b=value?.urlButton||value?.callButton||value?.quickReplyButton||value?.buttonText||native;
  const label=text(b?.displayText||b?.display_text||b?.text);
  if(!label)return '';
  const target=url(b.url),phone=text(b.phoneNumber||b.phone_number);
  return target?`${label}: ${target}`:phone&&/^\+?[\d ()-]{5,30}$/.test(phone)?`${label}: ${phone}`:label;
}

// Templates carry their text outside conversation/extendedTextMessage. Keep
// human-readable labels, never opaque reply IDs or native-flow JSON metadata.
export function richMessage(message){
  const template=message.templateMessage;
  const hydrated=template?.hydratedTemplate||template?.hydratedFourRowTemplate;
  const four=template?.fourRowTemplate;
  const interactive=template?.interactiveMessageTemplate||message.interactiveMessage;
  const buttons=message.buttonsMessage;
  let parts=[],source=null;
  if(hydrated){source=hydrated;parts=[hydrated.hydratedTitleText,hydrated.hydratedContentText,hydrated.hydratedFooterText,...(hydrated.hydratedButtons||[]).slice(0,20).map(button)];}
  else if(interactive){source=interactive.header;parts=[interactive.header?.title,interactive.body?.text,interactive.footer?.text,...(interactive.nativeFlowMessage?.buttons||[]).slice(0,20).map(button)];}
  else if(four){source=four;parts=[four.content?.text,four.footer?.text,...(four.buttons||[]).slice(0,20).map(button)];}
  else if(buttons){source=buttons;parts=[buttons.contentText,buttons.footerText,...(buttons.buttons||[]).slice(0,20).map(button)];}
  const field=['imageMessage','videoMessage','documentMessage'].find(k=>source?.[k]);
  return {body:parts.map(text).filter(Boolean).join('\n\n').slice(0,12000),field,item:field?source[field]:null};
}
