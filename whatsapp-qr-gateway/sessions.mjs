import makeWASocket,{BufferJSON,DisconnectReason,initAuthCreds,proto,generateMessageIDV2,downloadMediaMessage} from 'baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import {randomUUID} from 'node:crypto';
import {qrHeaders} from '../vercel-app/lib/qr-protocol.mjs';
import {normalizeMessage,outboundContent,fetchAttachment,directJid,unwrap,jidPhone} from './messages.mjs';

export {BufferJSON};
const failure=(message,status=409,definite=true)=>Object.assign(Error(message),{status,definite});
const logger=pino({level:'silent'});
export class Sessions {
  constructor({store,origin,secret,makeSocket=makeWASocket,fetcher=fetch,download=downloadMediaMessage,maximum=10}) {
    Object.assign(this,{store,origin,secret,makeSocket,fetcher,download,maximum});
    this.sessions=new Map();this.flushing=false;this.closed=false;
  }
  status(id) {
    const s=this.sessions.get(id),validQr=s?.qr&&Date.now()-s.qrAt<55000;
    return {transport:'qr',connected:s?.status==='connected',status:s?.status||'disconnected',phone:s?.phone||'',qr:validQr?s.qr:null,qrExpiresAt:validQr?s.qrAt+55000:null};
  }
  async connect(id) {
    let s=this.sessions.get(id);
    if(s?.socket&&!s.stopped)return this.status(id);
    if(!s&&this.sessions.size>=this.maximum)throw failure('Limite de sessões do serviço atingido.',429);
    if(!s){s={id,status:'connecting',qr:null,stopped:false,retries:0};this.sessions.set(id,s);}
    s.stopped=false;this.store.enable(id);
    try{await this.start(s);}catch{ s.status='unavailable';this.reconnect(s);throw failure('Não foi possível iniciar o WhatsApp. Tente novamente.',503);}
    return this.status(id);
  }
  async pause(id){
    const s=this.sessions.get(id);
    if(s){s.stopped=true;s.status='paused';s.qr=null;clearTimeout(s.timer);const socket=s.socket;s.socket=null;socket?.end?.(Error('Canal desativado.'));}
    this.store.db.prepare('update sessions set enabled=0 where id=?').run(id);
    this.store.db.prepare('update inbox set done=1 where session=? and done=0').run(id);
    return this.status(id);
  }
  async resume(id){this.store.set(id,'system:receive-after',Math.floor(Date.now()/1000)*1000);return this.connect(id);}
  async start(s) {
    if(this.closed||s.stopped)return;
    clearTimeout(s.timer);s.status='connecting';
    const creds=this.store.get(s.id,'creds')||initAuthCreds();
    const auth={creds,keys:{
      get:async(type,ids)=>Object.fromEntries(ids.map(id=>{
        let value=this.store.get(s.id,`key:${type}:${id}`);
        if(type==='app-state-sync-key'&&value)value=proto.Message.AppStateSyncKeyData.fromObject(value);
        return [id,value];
      })),
      set:async data=>{
        this.store.db.exec('begin');
        try{for(const [type,items] of Object.entries(data))for(const [id,value] of Object.entries(items))this.store.set(s.id,`key:${type}:${id}`,value);this.store.db.exec('commit');}
        catch(error){this.store.db.exec('rollback');throw error;}
      }
    }};
    const socket=this.makeSocket({auth,logger,markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,
      shouldIgnoreJid:jid=>!directJid(jid)&&!jid.endsWith('@lid'),
      getMessage:async key=>this.store.get(s.id,`message:${key.id}`)});
    s.socket=socket;
    socket.ev.on('creds.update',update=>{if(!s.stopped&&s.socket===socket){Object.assign(creds,update);this.store.set(s.id,'creds',creds);}});
    socket.ev.on('connection.update',update=>{
      if(s.stopped||s.socket!==socket)return;
      if(update.qr){s.qrAt=Date.now();s.status='qr';s.qr=null;QRCode.toDataURL(update.qr,{width:280,margin:2}).then(qr=>{if(s.socket===socket&&s.status==='qr')s.qr=qr;}).catch(()=>{s.status='unavailable';});}
      if(update.connection==='open'){s.status='connected';s.qr=null;s.retries=0;s.phone=jidPhone(socket.user?.id);this.store.set(s.id,'creds',creds);}
      if(update.connection==='close'){
        s.socket=null;s.qr=null;const code=update.lastDisconnect?.error?.output?.statusCode;
        if(code===DisconnectReason.loggedOut){s.status='disconnected';s.stopped=true;this.store.disable(s.id);}
        else if(code===DisconnectReason.connectionReplaced||code===DisconnectReason.forbidden){s.status='replaced';s.stopped=true;this.store.db.prepare('update sessions set enabled=0 where id=?').run(s.id);}
        else {s.status='reconnecting';this.reconnect(s);}
      }
    });
    socket.ev.on('messages.upsert',({messages,type})=>{
      if(type!=='notify'||s.stopped||s.socket!==socket)return;
      for(const message of messages){
        const cutoff=this.store.get(s.id,'system:receive-after')||0;
        if(cutoff&&Number(message.messageTimestamp)*1000<cutoff)continue;
        if(!message.key?.id||!message.message||(!directJid(message.key.remoteJid)&&!message.key.remoteJid?.endsWith('@lid')))continue;
        const m=unwrap(message.message);
        if(m.protocolMessage||m.senderKeyDistributionMessage)continue;
        if(message.key.fromMe&&this.store.wasSent(s.id,message.key.id))continue;
        this.store.set(s.id,`message:${message.key.id}`,message.message);
        this.store.accept(s.id,message);
      }
      this.flush().catch(()=>{});
    });
  }
  reconnect(s) {
    if(this.closed||s.stopped)return;
    clearTimeout(s.timer);const delay=Math.min(60000,1000*2**Math.min(s.retries++,6));
    s.timer=setTimeout(()=>this.start(s).catch(()=>{s.status='reconnecting';this.reconnect(s);}),delay);s.timer.unref();
  }
  async disconnect(id) {
    const s=this.sessions.get(id);
    if(s){s.stopped=true;s.status='disconnected';s.qr=null;clearTimeout(s.timer);
      if(s.socket){const socket=s.socket;s.socket=null;try{await Promise.race([socket.logout(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),5000);timer.unref();})]);}catch{}socket.end?.(Error('Desconectado pelo administrador.'));}
    }
    this.store.disable(id);return this.status(id);
  }
  async send(id,input) {
    if(typeof input.idempotencyKey!=='string'||!/^[-a-zA-Z0-9:]{1,160}$/.test(input.idempotencyKey))throw failure('Identificador do envio inválido.',400);
    const previous=this.store.sent(id,input.idempotencyKey);
    if(previous){
      const original=this.store.open(previous.body);
      const mediaIdentity=media=>media?JSON.stringify({kind:media.kind,mime:media.mime,name:media.name,url:new URL(media.url).origin+new URL(media.url).pathname}):'';
      if(original.recipient!==input.recipient||original.body!==input.body||mediaIdentity(original.media)!==mediaIdentity(input.media))throw failure('Identificador já utilizado para outra mensagem.');
      if(previous.state==='sent')return {external:previous.external};
      throw failure('Envio anterior sem confirmação. Confira o WhatsApp antes de reenviar.',409,false);
    }
    const s=this.sessions.get(id);if(!s||s.status!=='connected'||!s.socket)throw failure('WhatsApp desconectado. Reconecte pelo QR Code.');
    let bytes,content;try{bytes=input.media?await fetchAttachment(input.media,this.origin,this.fetcher):null;content=outboundContent(input,bytes);}catch{throw failure('Mensagem ou anexo inválido/indisponível.',400);}
    // Check again after downloading the attachment, before claiming the send.
    if(s.stopped||s.status!=='connected'||!s.socket)throw failure('Canal pausado ou desconectado antes do envio.');
    if(this.store.sent(id,input.idempotencyKey))return this.send(id,input);
    const socket=s.socket,external=generateMessageIDV2(socket.user?.id);
    this.store.recordSend(id,input.idempotencyKey,external,input);
    try{
      const sent=await socket.sendMessage(`${input.recipient}@s.whatsapp.net`,content,{messageId:external});
      if(sent?.key?.id!==external)throw Error('Envio sem identificador.');
      if(sent.message)this.store.set(id,`message:${external}`,sent.message);
      this.store.sendState(id,input.idempotencyKey,'sent');return {external};
    }catch{this.store.sendState(id,input.idempotencyKey,'uncertain');throw failure('Envio sem confirmação. Confira o WhatsApp antes de reenviar.',502,false);}
  }
  async flush() {
    if(this.flushing||this.closed)return;this.flushing=true;
    try{for(const row of this.store.pending()){
      try{
        if(this.sessions.get(row.session)?.stopped)continue;
        let event=row.event?this.store.open(row.event):null;
        if(!event){
          const s=this.sessions.get(row.session);if(!s?.socket)continue;
          const message=await normalizeMessage(this.store.open(row.body),{session:row.session,socket:s.socket,store:this.store,download:this.download,skipMedia:row.attempts>=3});
          event={id:row.id,session:row.session,message};this.store.event(row.session,row.id,event);
        }
        const account=row.session.split('_')[1],path=`/webhooks/whatsapp-qr/${account}`,body=JSON.stringify(event);
        const response=await this.fetcher(this.origin+path,{method:'POST',headers:qrHeaders(this.secret,'POST',path,body),body,redirect:'error',signal:AbortSignal.timeout(45000)});
        await response.body?.cancel();if(!response.ok)throw Error('Callback indisponível.');
        this.store.done(row.session,row.id);
      }catch{this.store.retry(row);}
    }}finally{this.flushing=false;}
  }
  async restore() {for(const id of this.store.active())await this.connect(id).catch(()=>{});}
  close() {this.closed=true;for(const s of this.sessions.values()){s.stopped=true;clearTimeout(s.timer);s.socket?.end?.(Error('Serviço encerrado.'));}}
}
