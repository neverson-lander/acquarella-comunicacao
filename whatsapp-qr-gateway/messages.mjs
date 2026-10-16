import {randomUUID} from 'node:crypto';

export const directJid=jid=>typeof jid==='string'&&/^\d+(?::\d+)?@s\.whatsapp\.net$/.test(jid);
export const jidPhone=jid=>directJid(jid)?jid.split('@')[0].split(':')[0]:'';
export function unwrap(message) {
  let m=message||{};
  for(let i=0;i<5;i++){
    const nested=m.ephemeralMessage?.message||m.viewOnceMessage?.message||m.viewOnceMessageV2?.message||m.documentWithCaptionMessage?.message;
    if(!nested)break;m=nested;
  }
  return m;
}
export async function normalizeMessage(raw,{session,socket,store,download,skipMedia=false}) {
  let jid=raw.key.remoteJid;
  if(!directJid(jid)&&jid?.endsWith('@lid'))jid=raw.key.remoteJidAlt||await socket.signalRepository?.lidMapping?.getPNForLID(jid);
  const customer=jidPhone(jid);
  if(!/^\d{10,15}$/.test(customer))throw Error('Aguardando identificação do telefone do contato.');
  const m=unwrap(raw.message),timestamp=Number(raw.messageTimestamp)*1000;
  if(!Number.isSafeInteger(timestamp)||timestamp<1)throw Error('Mensagem sem data válida.');
  let body=m.conversation||m.extendedTextMessage?.text||'',kind='text',media=null;
  const field=Object.keys(m).find(k=>['imageMessage','audioMessage','videoMessage','documentMessage','stickerMessage'].includes(k)),item=field&&m[field];
  if(item){
    kind=field.replace('Message','');
    body=item.caption||`[${({image:'Imagem',audio:'Áudio',video:'Vídeo',document:'Documento',sticker:'Figurinha'})[kind]} recebida no WhatsApp]`;
    // View-once content is not retained outside its native viewing flow.
    if(item.viewOnce||raw.message?.viewOnceMessage||raw.message?.viewOnceMessageV2){kind='unsupported';body='[Mídia de visualização única: consulte o WhatsApp]';}
    else {
      const maximum=(kind==='document'?25:16)*1024*1024;
      if(skipMedia)body+=' [Anexo indisponível na central; consulte o WhatsApp]';
      else if(Number(item.fileLength)>maximum)body+=' [Anexo acima do limite da central]';
      else {
        const stream=await download({key:raw.key,message:m},'stream',{}, {reuploadRequest:socket.updateMediaMessage});
        const chunks=[];let length=0;
        for await(const chunk of stream){length+=chunk.length;if(length>maximum){stream.destroy?.();throw Error('Anexo excede o limite.');}chunks.push(chunk);}
        const qrId=randomUUID(),mime=String(item.mimetype||'application/octet-stream').slice(0,100);
        store.saveMedia(session,qrId,Buffer.concat(chunks),mime);
        media={qrId,mime_type:mime,name:String(item.fileName||kind).replace(/[\x00-\x1f/\\]/g,'_').slice(0,180),size:length};
      }
    }
  }
  const reaction=m.reactionMessage?{target:m.reactionMessage.key?.id||'',emoji:m.reactionMessage.text||''}:null;
  if(reaction){kind='reaction';body='[Reação]';}
  if(!body){kind='unsupported';body='[Conteúdo não suportado: consulte o WhatsApp]';}
  return {customer,external:raw.key.id,fromMe:!!raw.key.fromMe,name:raw.key.fromMe?'':String(raw.pushName||'').slice(0,200),timestamp,body:body.slice(0,12000),kind,media,reaction,context:(item||m.extendedTextMessage)?.contextInfo?.stanzaId};
}

export function outboundContent(input,bytes) {
  if(!/^\d{10,15}$/.test(input.recipient)||typeof input.body!=='string'||input.body.length>6000)throw Error('Mensagem inválida.');
  if(!input.media){if(!input.body.trim())throw Error('Mensagem vazia.');return {text:input.body};}
  const m=input.media;
  if(!['image','audio','video','file'].includes(m.kind)||typeof m.mime!=='string'||m.mime.length>100)throw Error('Anexo inválido.');
  const key=m.kind==='file'?'document':m.kind;
  return {[key]:bytes,mimetype:m.mime,...(key==='document'?{fileName:String(m.name||'anexo').slice(0,180)}:{}),...(['image','video','document'].includes(key)&&input.body?{caption:input.body}:{})};
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
