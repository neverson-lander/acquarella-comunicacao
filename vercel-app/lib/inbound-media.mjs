import {mediaDisposition} from './media-filename.mjs';
const fail=(message,status=502)=>Object.assign(Error(message),{status});
const domains=['fbcdn.net','cdninstagram.com','fbsbx.com','facebook.com','instagram.com'];
export function inboundMediaUrl(value){
 if(typeof value!=='string'||value.length>16000)return '';
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d))?u.href:'';}catch{return '';}
}
const kindLabels={image:'Imagem',audio:'Áudio',video:'Vídeo',file:'Arquivo',sticker:'Figurinha',shared:'Anexo compartilhado'};
export function metaAttachments(message){
 const attachments=Array.isArray(message?.attachments)?message.attachments:Array.isArray(message?.attachments?.data)?message.attachments.data:[];
 const items=[];
 for(const a of attachments.slice(0,20)){
  const provided=a.type==='document'?'file':a.type|| (a.image_data?'image':a.video_data?'video':a.mime_type?.startsWith('audio/')?'audio':a.file_url?'file':'');
  const kind=kindLabels[provided]?provided:'shared';
  const url=inboundMediaUrl(a.payload?.url||a.image_data?.url||a.video_data?.url||a.file_url||a.url);if(!url)continue;
  const name=String(a.name||a.filename||a.payload?.filename||kindLabels[kind]).replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);
  items.push({kind,url,name});
 }
 return items.length?{kind:items[0].kind,media:{items,...(typeof message.text==='string'&&message.text?{caption:message.text.slice(0,4000)}:{})}}:null;
}
export function incomingBody(message){
 if(typeof message.text==='string'&&message.text)return message.text;
 const parsed=metaAttachments(message),labels={image:'Imagem recebida',audio:'Áudio recebido',video:'Vídeo recebido',file:'Arquivo recebido',sticker:'Figurinha recebida',shared:'Anexo compartilhado recebido'};return parsed?parsed.media.items.map(a=>`[${labels[a.kind]}]`).join(' '):'[Conteúdo não disponibilizado pela Meta. Consulte o canal de origem.]';
}
export const inboundMimeAllowed=(kind,mime)=>['image','sticker'].includes(kind)?['image/jpeg','image/png','image/gif','image/webp','image/avif'].includes(mime):kind==='audio'?['audio/ogg','audio/aac','audio/mp4','audio/mpeg','audio/amr','audio/wav','audio/x-wav','audio/webm','video/mp4'].includes(mime):kind==='video'?['video/mp4','video/quicktime','video/webm','video/ogg','video/x-msvideo'].includes(mime):kind==='file'||kind==='document';
export function streamInbound(response,{kind,mime,name,range,download,preview=false,maximum=25*1024*1024}){
 if(!inboundMimeAllowed(kind,mime))throw fail('A Meta retornou um formato de anexo incompatível.');
 if(Number(response.headers.get('content-length'))>maximum){response.body?.cancel().catch(()=>{});throw fail('O anexo excede o limite de visualização de 25 MB.',413);}
 const reader=response.body.getReader();let size=0;
 const body=new ReadableStream({async pull(controller){try{const chunk=await reader.read();if(chunk.done){controller.close();return;}size+=chunk.value.byteLength;if(size>maximum){await reader.cancel();controller.error(Error('Mídia excede o limite.'));return;}controller.enqueue(chunk.value);}catch(error){controller.error(error);}},cancel:reason=>reader.cancel(reason)});
 const headers={'content-type':mime,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'content-disposition':mediaDisposition(name||kindLabels[kind]||'Anexo',mime,{download,preview,document:['file','document'].includes(kind)}),'x-attachment-kind':kind};
 for(const field of ['content-range','accept-ranges','content-length'])if(response.headers.has(field))headers[field]=response.headers.get(field);
 return new Response(body,{status:response.status===206?206:200,headers});
}
async function providerFetch(url,{range,fetcher}){
 for(let hop=0;hop<4;hop++){
  const safe=inboundMediaUrl(url);if(!safe)throw fail('Endereço de mídia não permitido.');
  // CDN links supplied by webhooks are already signed. Never send a channel token to them.
  const response=await fetcher(safe,{headers:range?{Range:range}:{},redirect:'manual',signal:AbortSignal.timeout(45000)});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw fail('Redirecionamento de mídia inválido.');url=new URL(location,safe).href;continue;}
  return response;
 }
 throw fail('Muitos redirecionamentos de mídia.');
}
export async function metaInboundResponse({account,secrets,message,index=0,range,download=false,preview=false,fetcher=fetch,save=async()=>{}}){
 if(!['instagram','messenger'].includes(account.channel)||account.mode!=='live')throw fail('Anexo não disponível.',404);
 if(range&&!/^bytes=\d*-\d*$/.test(range))throw fail('Intervalo de mídia inválido.',416);
 let item=message.media?.items?.[index];if(!item)throw fail('Anexo não encontrado.',404);
 let response=await providerFetch(item.url,{range,fetcher});
 if([400,401,403,404,410].includes(response.status)){
  await response.body?.cancel();
  const external=message.external?.startsWith(account.id+':')?message.external.slice(account.id.length+1):'';
  if(external){
   const host=account.channel==='instagram'?'graph.instagram.com':'graph.facebook.com';
   const fresh=await fetcher(`https://${host}/${secrets.version||'v26.0'}/${encodeURIComponent(external)}?fields=attachments`,{headers:{Authorization:`Bearer ${secrets.token}`},redirect:'error',signal:AbortSignal.timeout(10000)});
   const parsed=fresh.ok?metaAttachments(await fresh.json()):null;
   if(parsed?.media.items[index]){await save(parsed);item=parsed.media.items[index];response=await providerFetch(item.url,{range,fetcher});}
  }
 }
 if(response.status===416)throw fail('Intervalo de mídia indisponível.',416);
 if(!response.ok||!response.body)throw fail('Este anexo está indisponível na Meta. Peça ao cliente para enviá-lo novamente.',404);
 const mime=String(response.headers.get('content-type')||'application/octet-stream').split(';')[0].trim().toLowerCase();
 const kind=item.kind==='shared'?(mime.startsWith('image/')?'image':mime.startsWith('audio/')?'audio':mime.startsWith('video/')?'video':'file'):item.kind;
 if(item.kind==='shared'&&mime==='text/html')throw fail('Este compartilhamento deve ser aberto no Instagram.');
 return streamInbound(response,{kind,mime,name:item.name,range,download,preview});
}
