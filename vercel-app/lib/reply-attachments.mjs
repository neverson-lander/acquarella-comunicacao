import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {attachmentInfo,CHUNK_SIZE} from '../public/attachment-policy.mjs';
import {signedReply} from './sac.mjs';
import {mediaDisposition} from './media-filename.mjs';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status,definite:true});};
export function checkFileHeader(mime,bytes){
 const prefix=bytes.subarray(0,16),ascii=prefix.toString('latin1');
 const valid=mime==='image/png'?prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
 mime==='image/jpeg'?prefix[0]===255&&prefix[1]===216&&prefix[2]===255:
 mime==='image/gif'?/^GIF8[79]a/.test(ascii):mime==='application/pdf'?ascii.startsWith('%PDF-'):
 mime==='audio/wav'?ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WAVE':
 mime==='audio/ogg'?ascii.startsWith('OggS'):mime==='audio/amr'?ascii.startsWith('#!AMR'):
 mime==='audio/mpeg'?ascii.startsWith('ID3')||(prefix[0]===255&&(prefix[1]&224)===224):
 mime==='audio/aac'?prefix[0]===255&&(prefix[1]&246)===240:
 ['audio/mp4','video/mp4','video/quicktime'].includes(mime)?['ftyp','moov','mdat','wide'].includes(ascii.slice(4,8)):
 mime.includes('officedocument')?ascii.startsWith('PK\x03\x04'):
 ['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint'].includes(mime)?prefix.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')):
 mime==='text/plain'?!bytes.includes(0)&&!/^\s*<(?:!doctype|html|script|svg)/i.test(bytes.toString('utf8')):false;
 if(!valid)fail('O conteúdo do arquivo não corresponde ao formato informado. Exporte novamente no formato aceito.');
}
export function mediaPayload(channel,recipient,media,url){
 if(channel==='whatsapp'){
  const kind=media.kind==='file'?'document':media.kind;
  return {messaging_product:'whatsapp',to:recipient,type:kind,[kind]:{link:url,...(kind==='document'?{filename:media.name}:{})}};
 }
 return {recipient:{id:recipient},message:{attachment:{type:media.kind,payload:{url}}},...(channel==='messenger'?{messaging_type:'RESPONSE'}:{})};
}
export function createReplyAttachments({pool,seal,open,key,now=Date.now,origin}){
 const query=(sql,args=[])=>pool.query(sql,args),one=async(sql,args)=>(await query(sql,args)).rows[0];
 const tag=(id,expires)=>createHmac('sha256',key()).update(`reply-media:${id}:${expires}`).digest('hex');
 async function owned(user,c,id,client=pool){
  if(!/^[0-9a-f-]{36}$/i.test(String(id)))fail('Anexo inválido.');
  const item=(await client.query('select * from reply_attachments where id=$1 and tenant=$2 and conversation=$3',[id,user.tenant,c.id])).rows[0];
  if(!item||item.uploader!==user.id)fail('Anexo não disponível para este operador.',403);
  return item;
 }
 async function begin(user,c,a,input){
  const info=attachmentInfo(a.channel,input);
  await query('delete from reply_attachments where tenant=$1 and uploader=$2 and message is null and created<$3',[user.tenant,user.id,now()-86400000]);
  const count=await one('select count(*)::integer as n from reply_attachments where tenant=$1 and uploader=$2 and message is null',[user.tenant,user.id]);
  if(count.n>=5)fail('Há anexos pendentes. Remova um anexo antes de adicionar outro.',429);
  const id=randomUUID();
  await query('insert into reply_attachments(id,tenant,conversation,uploader,name,mime,kind,size,created) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,user.tenant,c.id,user.id,info.name,info.mime,info.kind,info.size,now()]);
  return {id,chunkSize:CHUNK_SIZE};
 }
 async function part(user,c,id,input){
  // Serialize uploads/finalization with the same attachment lock; retries replace only an unfinalized part.
  const client=await pool.connect();
  try{
   await client.query('begin');await client.query('select id from reply_attachments where id=$1 for update',[id]);
   const item=await owned(user,c,id,client),index=input.part;
   if(item.ready||item.message)fail('Este anexo já foi finalizado.');
   if(!Number.isInteger(index)||index<0||index>=Math.ceil(item.size/CHUNK_SIZE))fail('Parte inválida.');
   if(typeof input.data!=='string'||input.data.length>Math.ceil(CHUNK_SIZE/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))fail('Parte de arquivo inválida.');
   const bytes=Buffer.from(input.data,'base64'),expected=Math.min(CHUNK_SIZE,item.size-index*CHUNK_SIZE);
   if(bytes.length!==expected||bytes.toString('base64')!==input.data)fail('Tamanho da parte inválido.');
   if(index===0)checkFileHeader(item.mime,bytes);
   await client.query('insert into reply_attachment_parts(attachment,part,secret) values($1,$2,$3) on conflict(attachment,part) do update set secret=excluded.secret',[id,index,seal(input.data)]);
   await client.query('commit');return {ok:true};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
 }
 async function finish(user,c,id){
  const client=await pool.connect();try{
   await client.query('begin');await client.query('select id from reply_attachments where id=$1 for update',[id]);
   const item=await owned(user,c,id,client);
   const parts=(await client.query('select part from reply_attachment_parts where attachment=$1 order by part',[id])).rows;
   if(parts.length!==Math.ceil(item.size/CHUNK_SIZE)||parts.some((p,i)=>p.part!==i))fail('Upload incompleto. Selecione o arquivo novamente.');
   await client.query('update reply_attachments set ready=true where id=$1',[id]);await client.query('commit');return {ok:true};
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
 }
 async function remove(user,c,id){await owned(user,c,id);await query('delete from reply_attachments where id=$1 and message is null',[id]);return {ok:true};}
 async function enqueue(user,c,a,input){
  if(!/^[0-9a-f-]{36}$/i.test(String(input.attachmentId)))fail('Anexo inválido.');
  const client=await pool.connect();try{
   await client.query('begin');await client.query('select id from reply_attachments where id=$1 for update',[input.attachmentId]);
   const item=await owned(user,c,input.attachmentId,client);
   if(item.message){await client.query('commit');return item.message;}
   if(!item.ready)fail('Aguarde o upload terminar antes de enviar.');
   attachmentInfo(a.channel,{name:item.name,mime:item.mime,size:item.size});
   const body=String(input.body||'').trim();if(body.length>2000)fail('Mensagem muito longa.');
   const signed=body?signedReply(user.name,body):'';
   const mid=randomUUID(),state=a.mode==='demo'?'simulated':'queued';
   const media={attachmentId:item.id,name:item.name,mime_type:item.mime,size:item.size};
   await client.query("insert into messages(id,conversation,direction,body,kind,media,created,state,operator_id,operator_name) values($1,$2,'out',$3,$4,$5,$6,$7,$8,$9)",[mid,c.id,item.name,item.kind,JSON.stringify(media),now(),state,user.id,user.name]);
   await client.query('update reply_attachments set message=$1 where id=$2',[mid,item.id]);
   if(a.mode==='live')await client.query("insert into jobs(id,tenant,account,conversation,message,kind,recipient,body,state,error,created) values($1,$2,$3,$4,$5,'reply',$6,'','pending','',$7)",[randomUUID(),user.tenant,a.id,c.id,mid,c.customer,now()]);
   if(body){
    const tid=randomUUID();await client.query("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name) values($1,$2,'out',$3,$4,$5,$6,$7)",[tid,c.id,body,now()+1,state,user.id,user.name]);
    if(a.mode==='live')await client.query("insert into jobs(id,tenant,account,conversation,message,kind,recipient,body,state,error,created) values($1,$2,$3,$4,$5,'reply',$6,$7,'pending','',$8)",[randomUUID(),user.tenant,a.id,c.id,tid,c.customer,signed,now()+1]);
   }
   await client.query('update conversations set updated=$1 where id=$2',[now(),c.id]);await client.query('commit');return mid;
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
 }
 async function delivery(id){
  const item=await one('select * from reply_attachments where id=$1 and ready and message is not null',[id]);
  if(!item)fail('Anexo não encontrado.',404);
  const expires=String(now()+15*60000);
  return {item,url:`${origin()}/api/attachments/${id}/delivery?expires=${expires}&signature=${tag(id,expires)}`};
 }
 function validSignature(id,expires,signature){
  if(!/^\d{13}$/.test(expires||'')||Number(expires)<now()||Number(expires)>now()+15*60000||!/[a-f0-9]{64}/.test(signature||'')||signature.length!==64)return false;
  return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(tag(id,expires),'hex'));
 }
 async function response(id,{range,download=false,preview=false,publicDelivery=false}={}){
  const item=await one('select * from reply_attachments where id=$1 and ready',[id]);if(!item)fail('Anexo não encontrado.',404);
  let start=0,end=item.size-1;
  if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))fail('Intervalo inválido.',416);
   if(!m[1])start=Math.max(0,item.size-Number(m[2]));else start=Number(m[1]);
   if(m[1]&&m[2])end=Math.min(end,Number(m[2]));
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=item.size)fail('Intervalo inválido.',416);
  }
  const parts=(await query('select part,secret from reply_attachment_parts where attachment=$1 and part between $2 and $3 order by part',[id,Math.floor(start/CHUNK_SIZE),Math.floor(end/CHUNK_SIZE)])).rows;
  if(parts.length!==Math.floor(end/CHUNK_SIZE)-Math.floor(start/CHUNK_SIZE)+1)fail('Anexo incompleto.',404);
  let index=0;
  const stream=new ReadableStream({pull(controller){if(index===parts.length){controller.close();return;}const part=parts[index++],bytes=Buffer.from(open(part.secret),'base64');controller.enqueue(bytes.subarray(Math.max(0,start-part.part*CHUNK_SIZE),Math.min(bytes.length,end-part.part*CHUNK_SIZE+1)));}});
  return new Response(stream,{status:range?206:200,headers:{'content-type':item.mime,'content-length':String(end-start+1),'cache-control':'private, no-store','accept-ranges':'bytes','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'content-disposition':mediaDisposition(item.name,item.mime,{download,preview,document:item.kind==='file'}),...(range?{'content-range':`bytes ${start}-${end}/${item.size}`}:{})}});
 }
 return {begin,part,finish,remove,enqueue,delivery,validSignature,response};
}
