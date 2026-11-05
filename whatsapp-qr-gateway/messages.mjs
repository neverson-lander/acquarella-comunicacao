import {randomUUID} from 'node:crypto';
import {proto} from 'baileys';
import {richMessage} from './rich-message.mjs';
import {extractReferral} from './referral.mjs';
import {decodeMessageEdit,isMessageEdit} from './message-edits.mjs';

export const directJid=jid=>typeof jid==='string'&&/^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid);
export const jidPhone=jid=>directJid(jid)?jid.split('@')[0].split(':')[0]:'';
export async function resolveRecipient(socket,phone){
  if(!/^\d{10,15}$/.test(phone))throw Error('Telefone de destino inválido.');
  const base=p=>/^55[1-9]\d9[6-9]\d{7}$/.test(p)?p.slice(0,4)+p.slice(5):p;
  const candidates=[phone];
  if(base(phone)!==phone)candidates.push(base(phone));
  else if(/^55[1-9]\d[6-9]\d{7}$/.test(phone))candidates.push(phone.slice(0,4)+'9'+phone.slice(4));
  let timer,registered;
  try{registered=await Promise.race([socket.onWhatsApp(...candidates),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Consulta de destinatário expirou.')),10000);timer.unref?.();})]);}finally{clearTimeout(timer);}
  const match=registered?.find(r=>r.exists&&directJid(r.jid)&&base(jidPhone(r.jid))===base(phone));
  if(!match)throw Error('Número não localizado no WhatsApp. Confira o código do país, DDD e telefone.');
  return match.jid;
}
export function unwrap(message) {
  let m=message||{};
  for(let i=0;i<5;i++){
    const nested=m.ephemeralMessage?.message||m.viewOnceMessage?.message||m.viewOnceMessageV2?.message||m.viewOnceMessageV2Extension?.message||m.documentWithCaptionMessage?.message;
    if(!nested)break;m=nested;
  }
  return m;
}
// Baileys protobuf instances serialize enum values to names when persisted.
// Accept both forms so a stored REVOKE is still an exclusion, not an empty chat.
export const deletionTarget=message=>{const p=unwrap(message).protocolMessage;return p&&(p.type===proto.Message.ProtocolMessage.Type.REVOKE||p.type==='REVOKE')?p.key?.id||'':'';};
export async function normalizeMessage(raw,{session,socket,store,download,skipMedia=false}) {
  let jid=raw.key.remoteJid;
  if(!directJid(jid)&&jid?.endsWith('@lid'))jid=raw.key.remoteJidAlt||await socket.signalRepository?.lidMapping?.getPNForLID(jid);
  const customer=jidPhone(jid);
  if(!/^\d{10,15}$/.test(customer))throw Error('Aguardando identificação do telefone do contato.');
  let m=unwrap(raw.message),edit=null,editUnavailable=false;
  if(isMessageEdit(m)){
    try{const decoded=decodeMessageEdit({...raw,message:m},{store,session,socket});const content=unwrap(decoded.message);const text=content.conversation||content.extendedTextMessage?.text||content.imageMessage?.caption||content.videoMessage?.caption||content.documentMessage?.caption;
      if(!decoded.target||typeof text!=='string'||!text.trim())throw Error('Texto da edição indisponível.');
      edit={target:decoded.target};m={conversation:text};
    }catch(error){if(!skipMedia)throw error;editUnavailable=true;m={conversation:'[Mensagem editada no WhatsApp: conteúdo atualizado indisponível na central. Consulte o WhatsApp.]'};}
  }
  const timestamp=Number(raw.messageTimestamp)*1000;
  if(!Number.isSafeInteger(timestamp)||timestamp<1)throw Error('Mensagem sem data válida.');
  const rich=richMessage(m);
  let body=m.conversation||m.extendedTextMessage?.text||rich.body||'',kind='text',media=null;
  const field=Object.keys(m).find(k=>['imageMessage','audioMessage','videoMessage','documentMessage','stickerMessage'].includes(k))||rich.field,item=field&&(m[field]||rich.item);
  if(item){
    kind=field.replace('Message','');
    const caption=body||item.caption||'';
    body=caption||`[${({image:'Imagem',audio:'Áudio',video:'Vídeo',document:'Documento',sticker:'Figurinha'})[kind]} recebida no WhatsApp]`;
    // View-once content is not retained outside its native viewing flow.
    let envelope=raw.message,viewOnce=!!item.viewOnce;
    for(let i=0;envelope&&i<5;i++){if(envelope.viewOnceMessage||envelope.viewOnceMessageV2||envelope.viewOnceMessageV2Extension)viewOnce=true;envelope=envelope.ephemeralMessage?.message||envelope.viewOnceMessage?.message||envelope.viewOnceMessageV2?.message||envelope.viewOnceMessageV2Extension?.message||envelope.documentWithCaptionMessage?.message;}
    if(viewOnce){kind='unsupported';body='[Mídia de visualização única: consulte o WhatsApp]';}
    else {
      const maximum=(kind==='document'?25:16)*1024*1024;
      if(skipMedia)body+=' [Anexo indisponível na central; consulte o WhatsApp]';
      else if(Number(item.fileLength)>maximum)body+=' [Anexo acima do limite da central]';
      else {
        const stream=await download({key:raw.key,message:{[field]:item}},'stream',{}, {reuploadRequest:socket.updateMediaMessage});
        const chunks=[];let length=0;
        for await(const chunk of stream){length+=chunk.length;if(length>maximum){stream.destroy?.();throw Error('Anexo excede o limite.');}chunks.push(chunk);}
        const qrId=randomUUID(),mime=String(item.mimetype||'application/octet-stream').slice(0,100);
        store.saveMedia(session,qrId,Buffer.concat(chunks),mime);
        media={qrId,mime_type:mime,name:String(item.fileName||kind).replace(/[\x00-\x1f/\\]/g,'_').slice(0,180),size:length,...(caption?{caption:caption.slice(0,12000)}:{})};
      }
    }
  }
  const reaction=m.reactionMessage?{target:m.reactionMessage.key?.id||'',emoji:m.reactionMessage.text||''}:null;
  if(reaction){kind='reaction';body='[Reação]';}
  const target=deletionTarget(raw.message),deletion=target?{target}:null;
  if(deletion){kind='deletion';body='[Mensagem excluída no WhatsApp]';}
  if(edit)kind='edit';
  if(editUnavailable)kind='unsupported';
  if(!body){kind='unsupported';body=m.placeholderMessage?'[O WhatsApp não disponibilizou o conteúdo desta mensagem. Confira no aplicativo.]':'[Conteúdo não suportado: consulte o WhatsApp]';}
  const referral=raw.key.fromMe?null:extractReferral(m);
  return {customer,external:raw.key.id,fromMe:!!raw.key.fromMe,name:raw.key.fromMe?'':String(raw.pushName||'').slice(0,200),timestamp,body:body.slice(0,12000),kind,media,reaction,deletion,...(edit?{edit}:{}),context:(item||m.extendedTextMessage)?.contextInfo?.stanzaId,...(referral?{referral}:{})};
}

export function outboundContent(input,bytes) {
  if(input.replyTo!==undefined&&input.replyTo!==null){
    const quote=input.replyTo;
    if(typeof quote!=='object'||typeof quote.external!=='string'||!quote.external||quote.external.length>200||/[\s\x00-\x1f]/.test(quote.external)||typeof quote.body!=='string'||quote.body.length>500)throw Error('Referência de resposta inválida.');
  }
  if(!/^\d{10,15}$/.test(input.recipient)||typeof input.body!=='string'||input.body.length>6000)throw Error('Mensagem inválida.');
  if(!input.media){if(!input.body.trim())throw Error('Mensagem vazia.');return {text:input.body};}
  const m=input.media;
  if(!['image','audio','video','file'].includes(m.kind)||typeof m.mime!=='string'||m.mime.length>100)throw Error('Anexo inválido.');
  const key=m.kind==='file'?'document':m.kind;
  return {[key]:bytes,mimetype:m.mime,...(key==='document'?{fileName:String(m.name||'anexo').slice(0,180)}:{}),...(['image','video','document'].includes(key)&&input.body?{caption:input.body}:{})};
}

export function quotedMessage(input,recipient,store,session){
  if(!input.replyTo)return null;
  return {key:{remoteJid:recipient,id:input.replyTo.external,fromMe:false},message:store.get(session,`message:${input.replyTo.external}`)||{conversation:input.replyTo.body||'[Mensagem recebida]'}};
}

export async function fetchAttachment(media,origin,fetcher=fetch) {
  const u=new URL(media.url);
  if(u.origin!==origin||u.username||u.password||!/^\/api\/attachments\/[a-f0-9-]{36}\/delivery$/i.test(u.pathname)||!u.searchParams.has('signature'))throw Error('Endereço de anexo inválido.');
  const response=await fetcher(u,{redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok||!response.body)throw Error('Anexo não disponível na central.');
  const maximum=25*1024*1024;
  if(Number(response.headers.get('content-length'))>maximum){await response.body.cancel();throw Error('Anexo excede o limite.');}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>maximum)throw Error('Anexo excede o limite.');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
