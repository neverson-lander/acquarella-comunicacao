import {uiIcon,fileSize} from './message-icons.js';
import {attachmentInfo,attachmentAccept} from './attachment-policy.mjs';
const emojis=['😀','😊','😍','🥰','😂','😉','😎','🤔','😢','🙏','👍','👎','👏','🙌','❤️','💚','💙','✨','🎉','✅','📍','📅','💬','🌸'];
export function createReplyComposer({api,toast}){
 const selections=new Map(),locks=new Set();let active=null;
 const current=id=>document.querySelector(`#reply[data-conversation="${id}"]`);
 function forget(id){const s=selections.get(id);if(s?.url)URL.revokeObjectURL(s.url);selections.delete(id);}
 function cancelRecording(){if(active){active.cancelled=true;active.stop();}}
 function clear(){locks.clear();cancelRecording();for(const id of selections.keys())forget(id);}
 function paint(id,readonly=false){
  const form=current(id);if(!form)return;const s=selections.get(id),recording=active?.id===id,locked=locks.has(id)||!!s?.uploading;
  const preview=form.querySelector('.attachment-preview'),recordButton=form.querySelector('[data-record]');
  form.querySelector('textarea').required=!s;form.classList.toggle('has-attachment',!!s);form.classList.toggle('is-recording',!!recording);
  recordButton.innerHTML=recording?'■ <span>Parar gravação</span>':uiIcon('mic')+'<span>Gravar áudio</span>';recordButton.setAttribute('aria-pressed',String(!!recording));recordButton.setAttribute('aria-label',recording?'Parar gravação':'Gravar áudio');
  form.querySelector('[data-attach]').disabled=readonly||recording||locked;recordButton.disabled=readonly||locked;form.querySelector('[data-emoji]').disabled=readonly||recording||locked;
  form.querySelector('.primary').disabled=readonly||recording||locked;
  if(recording){
   if(preview.dataset.recording!=='true'){preview.replaceChildren();preview.dataset.selectedUrl='';preview.dataset.recording='true';const label=document.createElement('p');label.className='recording-status';label.textContent='● Gravando… máximo de 3 minutos. Pare para ouvir antes de enviar.';label.setAttribute('role','status');preview.append(label);const cancel=document.createElement('button');cancel.type='button';cancel.className='attachment-remove';cancel.textContent='Descartar gravação';cancel.onclick=cancelRecording;preview.append(cancel);}return;
  }
  preview.dataset.recording='';
  if(!s){preview.replaceChildren();preview.dataset.selectedUrl='';return;}
  if(preview.dataset.selectedUrl!==s.url){
   preview.replaceChildren();preview.dataset.selectedUrl=s.url;const card=document.createElement('div');card.className='composer-attachment';
   const thumbnail=document.createElement('div');thumbnail.className='composer-attachment-thumb';
   if(['image','video'].includes(s.info.kind)){const media=document.createElement(s.info.kind==='image'?'img':'video');media.src=s.url;if(s.info.kind==='image')media.alt='Prévia do anexo';else{media.controls=true;media.preload='metadata';}thumbnail.append(media);}else thumbnail.innerHTML=uiIcon(s.info.kind==='audio'?'audio':'file');card.append(thumbnail);
   const details=document.createElement('div');details.className='composer-attachment-info';const description=document.createElement('strong');description.textContent=s.file.name+' · '+fileSize(s.file.size);description.title=s.file.name;details.append(description);
   const status=document.createElement('span');status.className='file-status';status.setAttribute('role','status');details.append(status);const progress=document.createElement('progress');progress.max=100;progress.setAttribute('aria-label','Progresso do anexo');details.append(progress);card.append(details);
   const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';remove.innerHTML=uiIcon('close');remove.setAttribute('aria-label','Remover anexo');remove.title='Remover anexo';remove.onclick=async()=>{if(s.attachmentId)try{await api('conversations/'+id+'/attachments/'+s.attachmentId+'/remove',{});}catch(error){toast(error.message);return;}forget(id);paint(id,readonly);};card.append(remove);preview.append(card);
   if(s.info.kind==='audio'){const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=s.url;audio.setAttribute('aria-label','Ouvir áudio antes de enviar');preview.append(audio);}
   const note=document.createElement('small');note.className='attachment-caption-note';note.textContent='Confira o anexo antes de enviar. Se houver texto, ele será enviado em outra mensagem.';preview.append(note);
  }
  preview.querySelector('.file-status').textContent=s.uploading?s.progress||'Preparando upload…':locked?'Enviando para o cliente…':'Pronto para enviar';const progress=preview.querySelector('progress');progress.hidden=!s.uploading;progress.value=s.percent||0;preview.querySelector('.attachment-remove').disabled=locked||readonly;
 }

 function select(id,channel,file,readonly){if(!file)return;try{const info=attachmentInfo(channel,file);const previous=selections.get(id);if(previous?.attachmentId){toast('Remova o anexo anterior antes de selecionar outro.');return;}forget(id);selections.set(id,{file,info,url:URL.createObjectURL(file)});paint(id,readonly);}catch(error){toast(error.message);}}
 async function record(id,channel,readonly){
  if(active){active.stop();return;}
  if(selections.has(id)){toast('Remova o anexo atual antes de gravar áudio.');return;}
  if(!navigator.mediaDevices?.getUserMedia){toast('Este navegador não permite gravar áudio. Anexe um arquivo de áudio.');return;}
  let stream;
  try{
   stream=await navigator.mediaDevices.getUserMedia({audio:true});
   if(!current(id)||readonly){stream.getTracks().forEach(t=>t.stop());return;}
   const mime=['audio/mp4',...(channel==='whatsapp'?['audio/ogg;codecs=opus']:[])].find(m=>globalThis.MediaRecorder?.isTypeSupported(m));
   const operation={id,cancelled:false,stop:()=>{}};active=operation;
   if(mime){
    const recorder=new MediaRecorder(stream,{mimeType:mime}),chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    operation.stop=()=>{if(recorder.state!=='inactive')recorder.stop();};
    recorder.onstop=()=>{clearTimeout(operation.timer);stream.getTracks().forEach(t=>t.stop());if(active===operation)active=null;if(!operation.cancelled){const type=mime.split(';')[0];select(id,channel,new File(chunks,`audio-${Date.now()}.${type==='audio/mp4'?'m4a':'ogg'}`,{type}),readonly);}paint(id,readonly);};
    recorder.onerror=()=>{operation.cancelled=true;operation.stop();toast('Falha ao gravar. Tente novamente ou anexe um áudio.');};recorder.start();
   }else if(channel!=='whatsapp'){
    // WAV PCM works in the Instagram and Messenger APIs when this browser has no MP4 recorder.
    const context=new AudioContext({sampleRate:16000}),source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),chunks=[];let samples=0;
    source.connect(processor);processor.connect(context.destination);processor.onaudioprocess=e=>{const data=new Float32Array(e.inputBuffer.getChannelData(0));chunks.push(data);samples+=data.length;};await context.resume();
    operation.stop=()=>{if(operation.stopped)return;operation.stopped=true;clearTimeout(operation.timer);processor.disconnect();source.disconnect();stream.getTracks().forEach(t=>t.stop());context.close();if(active===operation)active=null;
     if(!operation.cancelled&&samples){const buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer);const text=(offset,s)=>[...s].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));text(0,'RIFF');view.setUint32(4,36+samples*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,context.sampleRate,true);view.setUint32(28,context.sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples*2,true);let offset=44;for(const chunk of chunks)for(const sample of chunk){const v=Math.max(-1,Math.min(1,sample));view.setInt16(offset,v<0?v*32768:v*32767,true);offset+=2;}select(id,channel,new File([buffer],`audio-${Date.now()}.wav`,{type:'audio/wav'}),readonly);}paint(id,readonly);};
   }else{stream.getTracks().forEach(t=>t.stop());active=null;toast('Este navegador não grava em um formato aceito pelo WhatsApp. Anexe MP3, M4A, AAC ou OGG.');return;}
   operation.timer=setTimeout(operation.stop,180000);paint(id,readonly);
  }catch(error){stream?.getTracks().forEach(t=>t.stop());active=null;paint(id,readonly);toast(error.name==='NotAllowedError'?'Permita o acesso ao microfone para gravar áudio.':'Não foi possível iniciar a gravação. Anexe um áudio ou tente novamente.');}
 }
 function bind(form,{id,channel,readonly}){
  if(active&&active.id!==id)cancelRecording();form.dataset.conversation=id;
  const tools=document.createElement('div');tools.className='composer-tools';
  tools.innerHTML='<button type="button" class="composer-tool" data-emoji aria-label="Inserir emoji" title="Inserir emoji" aria-expanded="false">'+uiIcon('emoji')+'<span>Emojis</span></button><button type="button" class="composer-tool" data-attach aria-label="Anexar arquivo" title="Anexar arquivo ou colar uma imagem">'+uiIcon('attach')+'<span>Anexar</span></button><button type="button" class="composer-tool" data-record aria-pressed="false">'+uiIcon('mic')+'<span>Gravar áudio</span></button><input type="file" data-file hidden><div class="emoji-picker" hidden role="group" aria-label="Escolha um emoji"></div>';
  const input=form.querySelector('textarea'),bottom=form.querySelector('.composer-bottom');bottom.querySelector('small').classList.add('composer-operator');bottom.before(bottom.querySelector('small'));bottom.prepend(tools);
  const preview=document.createElement('div');preview.className='attachment-preview';preview.setAttribute('aria-label','Anexo da resposta');input.before(preview);
  const meta=document.createElement('div');meta.className='composer-meta';const limits=document.createElement('details');limits.className='composer-limits';const summary=document.createElement('summary');summary.textContent='Formatos e limites';limits.append(summary);const hint=document.createElement('p');hint.textContent=channel==='instagram'?'JPG/PNG até 8 MB. Áudio, vídeo MP4/MOV e PDF até 25 MB.':channel==='whatsapp'?'JPG/PNG até 5 MB. Áudio e vídeo MP4 até 16 MB. Documentos até 25 MB.':'Imagens até 8 MB. Áudio, vídeo e documentos até 25 MB.';limits.append(hint);meta.append(limits);const counter=document.createElement('span');counter.className='composer-counter';meta.append(counter);form.append(meta);
  const picker=tools.querySelector('.emoji-picker'),emoji=tools.querySelector('[data-emoji]'),file=tools.querySelector('[data-file]');file.accept=attachmentAccept(channel);
  let caret=[input.value.length,input.value.length];const remember=()=>{caret=[input.selectionStart,input.selectionEnd];counter.textContent=input.value.length+' / '+input.maxLength;counter.classList.toggle('near-limit',input.value.length>input.maxLength*.9);};for(const event of ['input','select','keyup','click'])input.addEventListener(event,remember);remember();
  emoji.onclick=()=>{picker.hidden=!picker.hidden;emoji.setAttribute('aria-expanded',String(!picker.hidden));};form.addEventListener('keydown',e=>{if(e.key==='Escape'){picker.hidden=true;emoji.setAttribute('aria-expanded','false');}});
  for(const value of emojis){const b=document.createElement('button');b.type='button';b.textContent=value;b.setAttribute('aria-label',value);b.onclick=()=>{if(input.value.length-(caret[1]-caret[0])+value.length>input.maxLength){toast('Limite de caracteres atingido.');return;}input.focus();input.setSelectionRange(...caret);input.setRangeText(value,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));remember();picker.hidden=true;emoji.setAttribute('aria-expanded','false');};picker.append(b);}
  const choose=selected=>{if(!readonly&&!locks.has(id))select(id,channel,selected,readonly);};tools.querySelector('[data-attach]').onclick=()=>file.click();file.onchange=()=>{choose(file.files[0]);file.value='';};tools.querySelector('[data-record]').onclick=()=>record(id,channel,readonly);
  input.addEventListener('paste',e=>{if(e.clipboardData?.files?.length){e.preventDefault();choose(e.clipboardData.files[0]);}});
  let dragDepth=0;form.addEventListener('dragenter',e=>{if(e.dataTransfer?.types.includes('Files')&&!readonly){e.preventDefault();dragDepth++;form.classList.add('drag-over');}});form.addEventListener('dragover',e=>{if(e.dataTransfer?.types.includes('Files'))e.preventDefault();});form.addEventListener('dragleave',()=>{if(--dragDepth<=0)form.classList.remove('drag-over');});form.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;form.classList.remove('drag-over');choose(e.dataTransfer?.files?.[0]);});paint(id,readonly);
 }

 async function prepare(id){
  if(active)throw Error('Pare a gravação antes de enviar.');const s=selections.get(id);if(!s)return null;if(s.attachmentId)return s.attachmentId;
  s.uploading=true;paint(id);let upload;
  try{
   upload=await api(`conversations/${id}/attachments`,{name:s.file.name,type:s.info.mime,size:s.file.size});
   for(let offset=0,part=0;offset<s.file.size;offset+=upload.chunkSize,part++){
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('Não foi possível ler o arquivo.'));reader.readAsDataURL(s.file.slice(offset,offset+upload.chunkSize));});
    await api(`conversations/${id}/attachments/${upload.id}/part`,{part,data});s.percent=Math.round(Math.min(offset+upload.chunkSize,s.file.size)/s.file.size*100);s.progress='Enviando anexo… '+s.percent+'%';paint(id);
   }
   await api(`conversations/${id}/attachments/${upload.id}/finish`,{});s.attachmentId=upload.id;return upload.id;
  }catch(error){if(upload)await api(`conversations/${id}/attachments/${upload.id}/remove`,{}).catch(()=>{});throw error;}finally{s.uploading=false;s.progress='';paint(id);}
 }
 return {bind,prepare,lock:(id,enabled)=>{enabled?locks.add(id):locks.delete(id);paint(id);},has:id=>selections.has(id),clear,forget,busy:()=>!!active};
}
