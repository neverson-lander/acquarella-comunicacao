import {createDecipheriv,hkdfSync} from 'node:crypto';
import {proto,jidNormalizedUser} from 'baileys';

const bytes=value=>typeof value==='string'?Buffer.from(value,'base64'):Buffer.from(value||[]);
export function isMessageEdit(message){
  const p=message?.protocolMessage,s=message?.secretEncryptedMessage;
  return p&&(p.type==='MESSAGE_EDIT'||p.type===proto.Message.ProtocolMessage.Type.MESSAGE_EDIT)||
    s&&(s.secretEncType==='MESSAGE_EDIT'||s.secretEncType===2);
}
export function decodeMessageEdit(raw,{store,session,socket}){
  const m=raw.message,p=m.protocolMessage;
  if(p&&(p.type==='MESSAGE_EDIT'||p.type===proto.Message.ProtocolMessage.Type.MESSAGE_EDIT))return {target:p.key?.id,message:p.editedMessage};
  const encrypted=m.secretEncryptedMessage;
  if(!isMessageEdit(m))return null;
  const target=encrypted.targetMessageKey?.id;
  const original=store.get(session,`message:${target}`),secret=bytes(original?.messageContextInfo?.messageSecret);
  if(!target||secret.length!==32)throw Error('Aguardando a mensagem original para ler a edição.');
  const remote=jidNormalizedUser(raw.key.remoteJid),own=remote.endsWith('@lid')?socket.user?.lid:socket.user?.id;
  const sender=raw.key.fromMe?jidNormalizedUser(own||''):remote;
  if(!sender)throw Error('Autor da edição indisponível.');
  const originalSender=encrypted.targetMessageKey.fromMe?sender:jidNormalizedUser(encrypted.targetMessageKey.remoteJid||'');
  const key=hkdfSync('sha256',secret,Buffer.alloc(0),Buffer.from(target+originalSender+sender+'Message Edit'),32);
  const payload=bytes(encrypted.encPayload),decipher=createDecipheriv('aes-256-gcm',key,bytes(encrypted.encIv));
  decipher.setAuthTag(payload.subarray(-16));
  const content=Buffer.concat([decipher.update(payload.subarray(0,-16)),decipher.final()]);
  const decoded=proto.Message.decode(content);
  return {target,message:decoded.protocolMessage?.editedMessage||decoded};
}
