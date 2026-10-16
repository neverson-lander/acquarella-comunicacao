export const CHUNK_SIZE=1024*1024;
const MB=1024*1024;
const common={image:['image/jpeg','image/png'],audio:['audio/aac','audio/mp4','audio/mpeg','audio/wav'],video:['video/mp4','video/quicktime'],file:['application/pdf']};
const office=['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain'];
const extensions={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',mp4:'video/mp4',mov:'video/quicktime',pdf:'application/pdf',txt:'text/plain',doc:office[0],docx:office[1],xls:office[2],xlsx:office[3],ppt:office[4],pptx:office[5]};
export function attachmentInfo(channel,file){
  const name=String(file.name||'anexo').replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);
  const ext=name.split('.').pop().toLowerCase(),declared=String(file.type||file.mime||'').split(';')[0].toLowerCase();
  const mime=declared==='audio/x-wav'?'audio/wav':declared==='audio/x-m4a'?'audio/mp4':declared&&declared!=='application/octet-stream'?declared:extensions[ext];
  const allowed={...common,...(channel==='messenger'?{image:[...common.image,'image/gif'],file:[...common.file,...office]}:{}),...(channel==='whatsapp'?{audio:['audio/aac','audio/mp4','audio/mpeg','audio/amr','audio/ogg'],video:['video/mp4'],file:[...common.file,...office]}:{})};
  const kind=Object.keys(allowed).find(k=>allowed[k].includes(mime));
  if(!['instagram','messenger','whatsapp'].includes(channel)||!kind)throw Error(channel==='instagram'?'Formato não aceito. No Instagram use JPG, PNG, áudio AAC/M4A/MP3/WAV, vídeo MP4/MOV ou PDF.':'Formato não aceito neste canal. Use imagens JPG/PNG, áudio, vídeo MP4, PDF, TXT ou documentos Office.');
  const maximum=(kind==='image'?(channel==='whatsapp'?5:8):channel==='whatsapp'&&['audio','video'].includes(kind)?16:25)*MB;
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>maximum)throw Error(`O limite para este anexo é ${maximum/MB} MB. Arquivos vazios não são aceitos.`);
  return {name,mime,kind,size:file.size,maximum};
}
export function attachmentAccept(channel){return [...new Set([...common.image,...common.audio,...common.video,...common.file,...(channel==='instagram'?[]:office),...(channel==='whatsapp'?['audio/ogg','audio/amr']:[])])].join(',');}
