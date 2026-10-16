import {randomUUID} from 'node:crypto';
import {qrHeaders,qrSessionId} from './qr-protocol.mjs';
import {mediaDisposition} from './media-filename.mjs';

const fail=(message,status=503,definite=true)=>Object.assign(Error(message),{status,definite});
export function qrConfiguration(env=process.env) {
  const secret=env.WHATSAPP_QR_SECRET||'';
  let url;try{url=new URL(env.WHATSAPP_QR_URL);}catch{throw fail('O serviço WhatsApp por QR Code ainda não foi configurado.');}
  const internal=env.DEPLOYMENT_MODE==='standalone'&&url.origin==='http://whatsapp-qr:3100';
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    !(url.protocol==='https:'||internal||(env.NODE_ENV!=='production'&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))||secret.length<32)
    throw fail('Configuração inválida do serviço WhatsApp por QR Code.');
  return {url:url.origin,secret};
}
export function createQrClient({env=process.env,fetcher=fetch}={}) {
  async function request(account,action,{method='POST',input,range,raw=false}={}) {
    const {url,secret}=qrConfiguration(env),path=`/sessions/${qrSessionId(account)}${action}`,body=input?JSON.stringify(input):'';
    let response;
    try{response=await fetcher(url+path,{method,headers:{...qrHeaders(secret,method,path,body),...(range?{Range:range}:{})},...(body?{body}:{}),redirect:'error',signal:AbortSignal.timeout(45000)});}
    catch{throw fail('Sem resposta do serviço WhatsApp por QR Code. Confira a conexão antes de reenviar.',502,action!=='/messages');}
    if(!response.ok){const result=await response.json().catch(()=>({}));throw fail(result.error||'Serviço WhatsApp por QR Code indisponível.',[404,416].includes(response.status)?response.status:502,result.definite===true||(response.status<500&&result.definite!==false));}
    return raw?response:response.json();
  }
  return {
    status:account=>request(account,'',{method:'GET'}),
    connect:account=>request(account,'/connect'),
    disconnect:account=>request(account,'/disconnect'),
    async send(account,recipient,body,media,idempotencyKey=randomUUID()) {
      const result=await request(account,'/messages',{input:{recipient,body,media,idempotencyKey}});
      if(!result.external)throw fail('O WhatsApp não confirmou o identificador do envio.',502,false);
      return result.external;
    },
    async media(account,message,{range,download=false,preview=false}={}) {
      if(!/^[a-f0-9-]{36}$/i.test(message.media?.qrId||''))throw fail('Anexo indisponível.',404);
      if(range&&!/^bytes=\d*-\d*$/.test(range))throw fail('Intervalo inválido.',416);
      const response=await request(account,`/media/${message.media.qrId}`,{method:'GET',range,raw:true}),headers=new Headers();
      for(const key of ['content-type','content-length','content-range','accept-ranges'])if(response.headers.has(key))headers.set(key,response.headers.get(key));
      headers.set('cache-control','private, no-store');headers.set('x-content-type-options','nosniff');headers.set('content-security-policy',"default-src 'none'; sandbox");
      headers.set('content-disposition',mediaDisposition(message.media.name||'anexo',headers.get('content-type')||'application/octet-stream',{download,preview,document:message.kind==='document'}));
      return new Response(response.body,{status:response.status,headers});
    }
  };
}

// Only the authenticated QR callback can enter this adapter. Never accept JIDs,
// remote URLs or session credentials from a browser form.
export function qrInboundPayload(account,event) {
  if(event?.session!==qrSessionId(account)||!event.id||event.id.length>200)throw fail('Evento QR inválido.',400);
  const m=event.message;
  if(!m||!/^\d{10,15}$/.test(m.customer)||typeof m.external!=='string'||!m.external||m.external.length>200||typeof m.body!=='string'||m.body.length>12000||!Number.isSafeInteger(m.timestamp)||m.timestamp<1||m.timestamp>Date.now()+300000)throw fail('Mensagem QR inválida.',400);
  const kinds=['text','image','audio','video','document','sticker','reaction','unsupported'];
  if(!kinds.includes(m.kind)||typeof m.fromMe!=='boolean')throw fail('Tipo de mensagem QR inválido.',400);
  let media=null;
  if(m.media){
    if(!/^[a-f0-9-]{36}$/i.test(m.media.qrId||'')||!['image','audio','video','document','sticker'].includes(m.kind)||typeof m.media.mime_type!=='string'||m.media.mime_type.length>100)throw fail('Anexo QR inválido.',400);
    media={qrId:m.media.qrId,name:String(m.media.name||'anexo').slice(0,180),mime_type:m.media.mime_type,size:Number(m.media.size)||0};
  }
  return {qrEcho:m.fromMe,entry:[{changes:[{value:{metadata:{phone_number_id:account.external},contacts:[{wa_id:m.customer,profile:{name:String(m.name||'').slice(0,200)}}],messages:[{
    id:m.external,from:m.customer,timestamp:Math.floor(m.timestamp/1000),type:m.kind,text:{body:m.body},qrMedia:media,
    ...(m.context?{context:{id:String(m.context).slice(0,200)}}:{}),
    ...(m.reaction?{reaction:{message_id:String(m.reaction.target||'').slice(0,200),emoji:String(m.reaction.emoji||'').slice(0,32)}}:{})
  }]}}]}]};
}
