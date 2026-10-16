const extensions={'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/avif':'avif','audio/ogg':'ogg','audio/aac':'aac','audio/mp4':'m4a','audio/mpeg':'mp3','audio/amr':'amr','audio/wav':'wav','audio/x-wav':'wav','audio/webm':'webm','video/mp4':'mp4','video/quicktime':'mov','video/webm':'webm','video/ogg':'ogv','video/3gpp':'3gp','video/x-msvideo':'avi','application/pdf':'pdf','text/plain':'txt','text/csv':'csv','application/msword':'doc','application/vnd.ms-excel':'xls','application/vnd.ms-powerpoint':'ppt','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx','application/zip':'zip','application/x-zip-compressed':'zip','application/octet-stream':'bin'};
export function mediaFilename(value,mime,fallback='anexo'){
 const type=String(mime||'').split(';')[0].trim().toLowerCase(),extension=extensions[type];
 let name=String(value||fallback).normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'').slice(0,160).trim()||fallback;
 // The actual Content-Type determines the extension. Generic binary downloads retain a provided extension.
 if(extension&&extension!=='bin'){
  const suffix=/\.([a-z0-9]{1,10})$/i.exec(name),aliases=type==='image/jpeg'?['jpg','jpeg']:type==='audio/mp4'?['m4a','mp4']:type==='audio/wav'||type==='audio/x-wav'?['wav']:[extension];
  if(!suffix)name+='.'+extension;else if(!aliases.includes(suffix[1].toLowerCase()))name=name.slice(0,-suffix[0].length)+'.'+extension;
 }else if(!/\.[a-z0-9]{1,10}$/i.test(name))name+='.'+(extension||'bin');
 return name;
}
export function mediaDisposition(name,mime,{download=false,preview=false,document=false}={}){
 const filename=mediaFilename(name,mime),ascii=filename.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'_');
 const encoded=encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
 return `${download||(document&&!(preview&&mime==='application/pdf'))?'attachment':'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
