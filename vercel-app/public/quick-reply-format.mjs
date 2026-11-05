const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const quickReplyKey=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
export function quickReplyContactName(conversation,crm={}){
 const opportunity=(crm.opportunities||[]).find(o=>o.conversation===conversation?.id),contact=(crm.contacts||[]).find(c=>c.id===opportunity?.contact);
 const clean=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
 return clean(contact?.name)||clean(conversation?.name);
}
export function fillQuickReplyVariables(body,{name}={}){
 return String(body??'').replace(/\{\s*nome\s*\}/gi,()=>{
  if(typeof name!=='string'||!name.trim())throw Error('O contato não tem nome informado. Identifique o cliente antes de usar uma resposta com {Nome}.');
  return name.replace(/\s+/g,' ').trim();
 });
}
// Parse only the formats supported by WhatsApp; HTML is always treated as text.
function inline(text,html=true){
 const pattern=/```([\s\S]+?)```|`([^`\n]+)`|(?<![\w])\*([^*\n]+)\*(?![\w])|(?<![\w])_([^_\n]+)_(?![\w])|(?<![\w])~([^~\n]+)~(?![\w])/g;
 let result='',last=0;
 for(const m of text.matchAll(pattern)){
  result+=html?esc(text.slice(last,m.index)):text.slice(last,m.index);
  const value=m[1]??m[2]??m[3]??m[4]??m[5],tag=m[1]!==undefined||m[2]!==undefined?'code':m[3]!==undefined?'strong':m[4]!==undefined?'em':'s';
  result+=html?`<${tag}>${tag==='code'?esc(value):inline(value)}</${tag}>`:tag==='code'?value:inline(value,false);last=m.index+m[0].length;
 }return result+(html?esc(text.slice(last)):text.slice(last));
}
export function quickReplyPreview(body){return String(body).split('\n').map(line=>{
 const quote=line.startsWith('> '),bullet=/^[-*] /.test(line),number=line.match(/^\d+\. /),prefix=quote?2:bullet?2:number?number[0].length:0;
 return `<div class="qr-preview-line${quote?' is-quote':''}${bullet||number?' is-list':''}">${bullet?'• ':number?esc(number[0]):''}${inline(line.slice(prefix))||'<br>'}</div>`;
}).join('');}
export function quickReplyText(body,channel){return channel==='whatsapp'?body:inline(body,false);}
