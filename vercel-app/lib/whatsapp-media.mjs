const fail=(message,status=502)=>Object.assign(Error(message),{status});
const types={image:new Set(['image/jpeg','image/png']),sticker:new Set(['image/webp']),audio:new Set(['audio/ogg','audio/aac','audio/mp4','audio/mpeg','audio/amr'])};
export function validMediaUrl(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['fbsbx.com','facebook.com','fbcdn.net'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host))?u.href:'';}catch{return '';}
}
export async function whatsappMediaResponse({account,secrets,message,range,download=false,fetcher=fetch}){
  if(account.channel!=='whatsapp'||account.mode!=='live'||!types[message.kind]||!/^\d{1,100}$/.test(message.media?.id||''))throw fail('Anexo não disponível.',404);
  if(range&&!/^bytes=\d*-\d*$/.test(range))throw fail('Intervalo de mídia inválido.',416);
  const headers={Authorization:`Bearer ${secrets.token}`};
  const metadata=await fetcher(`https://graph.facebook.com/${secrets.version||'v26.0'}/${message.media.id}?phone_number_id=${encodeURIComponent(account.external)}`,{headers,redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!metadata.ok)throw fail('A Meta não disponibilizou este anexo. Ele pode ter expirado ou a credencial do canal precisa ser renovada.',metadata.status===404?404:502);
  const media=await metadata.json(),url=validMediaUrl(media.url),mime=String(media.mime_type||'').split(';')[0].trim().toLowerCase();
  if(!url||!types[message.kind].has(mime))throw fail('Formato ou endereço de mídia não permitido.');
  const maximum=16*1024*1024;
  if(Number(media.file_size)>maximum)throw fail('Este anexo excede o limite de 16 MB.',413);
  const response=await fetcher(url,{headers:{...headers,...(range?{Range:range}:{})},redirect:'error',signal:AbortSignal.timeout(45000)});
  if(response.status===416)throw fail('Intervalo de mídia indisponível.',416);
  if(!response.ok||!response.body)throw fail('Não foi possível baixar este anexo da Meta.');
  if(Number(response.headers.get('content-length'))>maximum){await response.body.cancel();throw fail('Este anexo excede o limite de 16 MB.',413);}
  const reader=response.body.getReader();let size=0;
  const body=new ReadableStream({async pull(controller){try{const chunk=await reader.read();if(chunk.done){controller.close();return;}size+=chunk.value.byteLength;if(size>maximum){await reader.cancel();controller.error(Error('Mídia excede o limite.'));return;}controller.enqueue(chunk.value);}catch(error){controller.error(error);}},cancel:reason=>reader.cancel(reason)});
  const extension={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','audio/ogg':'ogg','audio/mp4':'m4a','audio/mpeg':'mp3','audio/aac':'aac','audio/amr':'amr'}[mime];
  const resultHeaders={'content-type':mime,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':`${download?'attachment':'inline'}; filename="whatsapp-${message.kind}.${extension}"`};
  for(const name of ['content-range','accept-ranges'])if(response.headers.has(name))resultHeaders[name]=response.headers.get(name);
  return new Response(body,{status:response.status===206?206:200,headers:resultHeaders});
}
