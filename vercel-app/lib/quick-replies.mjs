import {randomUUID} from 'node:crypto';
import {checkFileHeader} from './reply-attachments.mjs';
const CHUNK=256*1024;
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export function createQuickReplies({pool,seal,open,now=Date.now}){
 const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
 const access=user=>{if(!['admin','receptionist','agent'].includes(user.role))fail('Sem acesso às respostas rápidas.',403);};
 const manage=user=>{access(user);if(!['admin','receptionist'].includes(user.role))fail('Apenas administradores e recepcionistas podem alterar as respostas rápidas.',403);};
 async function transaction(callback){const db=await pool.connect();try{await db.query('begin');const r=await callback(db);await db.query('commit');return r;}catch(e){await db.query('rollback');if(e.code==='23505')fail('Já existe uma resposta rápida com esse nome.',409);throw e;}finally{db.release();}}
 async function asset(db,user,id,{lock=false,upload=false}={}){
  if(!uuid(id))fail('Imagem inválida.');
  const item=await one(db,`select * from quick_reply_assets where id=$1 and tenant=$2 ${lock?'for update':''}`,[id,user.tenant]);
  if(!item)fail('Imagem não encontrada.',404);
  if(upload&&(item.uploader!==user.id||item.ready))fail('Este upload não pode ser alterado.',403);
  return item;
 }
 async function list(user){access(user);const replies=(await pool.query('select q.*,a.name as image_name,a.mime as image_mime,a.size as image_size from quick_replies q left join quick_reply_assets a on a.id=q.asset and a.tenant=q.tenant where q.tenant=$1 order by lower(q.name),q.id',[user.tenant])).rows;return {replies,canManage:['admin','receptionist'].includes(user.role)};}
 async function save(user,input){manage(user);
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100)fail('Informe um nome com até 100 caracteres.');
  if(typeof input.body!=='string'||input.body.length>1800||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.body))fail('Use um texto com até 1.800 caracteres.');
  if(input.asset!==null&&!uuid(input.asset))fail('Imagem inválida.');
  if(!input.body.trim()&&!input.asset)fail('Escreva uma mensagem ou adicione uma imagem.');
  if(input.id&&!uuid(input.id))fail('Resposta rápida inválida.');
  return transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[user.tenant+':quick-replies']);
   const old=input.id?await one(db,'select * from quick_replies where id=$1 and tenant=$2 for update',[input.id,user.tenant]):null;
   if(input.id&&!old)fail('Resposta rápida não encontrada.',404);
   if(old&&input.version!==old.version)fail('Esta resposta foi alterada por outra pessoa. Atualize a lista antes de editar.',409);
   if(input.asset){const image=await asset(db,user,input.asset);if(!image.ready)fail('Conclua o upload da imagem antes de salvar.');}
   if(!old&&Number((await one(db,'select count(*) as n from quick_replies where tenant=$1',[user.tenant])).n)>=300)fail('Limite de 300 respostas rápidas por empresa.');
   const id=old?.id||randomUUID(),stamp=now();
   if(old)await db.query('update quick_replies set name=$1,body=$2,asset=$3,version=version+1,updated=$4 where id=$5 and tenant=$6',[input.name.trim(),input.body,input.asset,stamp,id,user.tenant]);
   else await db.query('insert into quick_replies(id,tenant,name,body,asset,created,updated) values($1,$2,$3,$4,$5,$6,$6)',[id,user.tenant,input.name.trim(),input.body,input.asset,stamp]);
   await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,`Resposta rápida ${input.name.trim()} ${old?'alterada':'criada'} por ${user.name}.`,stamp]);
   return {ok:true,id};
  });
 }
 async function remove(user,id,input){manage(user);if(!uuid(id))fail('Resposta rápida inválida.');return transaction(async db=>{
  const item=await one(db,'select * from quick_replies where id=$1 and tenant=$2 for update',[id,user.tenant]);if(!item)fail('Resposta rápida não encontrada.',404);
  if(input.version!==item.version)fail('Esta resposta foi alterada. Atualize a lista antes de excluir.',409);
  await db.query('delete from quick_replies where id=$1 and tenant=$2',[id,user.tenant]);
  await db.query('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[randomUUID(),user.tenant,`Resposta rápida ${item.name} excluída por ${user.name}.`,now()]);return {ok:true};
 });}
 async function begin(user,input){manage(user);
  if(!['image/jpeg','image/png'].includes(input.type)||!Number.isInteger(input.size)||input.size<1||input.size>5*1024*1024)fail('Use uma imagem JPG ou PNG de até 5 MB.');
  const name=String(input.name||'imagem').replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);
  return transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[user.tenant+':quick-assets:'+user.id]);
   await db.query('delete from quick_reply_assets a where tenant=$1 and created<$2 and not exists(select 1 from quick_replies q where q.asset=a.id)',[user.tenant,now()-86400000]);
   const pending=await one(db,'select count(*) as n from quick_reply_assets a where tenant=$1 and uploader=$2 and not exists(select 1 from quick_replies q where q.asset=a.id)',[user.tenant,user.id]);
   if(Number(pending.n)>=10)fail('Há imagens pendentes. Salve as respostas ou tente novamente mais tarde.',429);
   const id=randomUUID();await db.query('insert into quick_reply_assets(id,tenant,uploader,name,mime,size,created) values($1,$2,$3,$4,$5,$6,$7)',[id,user.tenant,user.id,name,input.type,input.size,now()]);return {id,chunkSize:CHUNK};
  });
 }
 async function upload(user,id,action,input){manage(user);return transaction(async db=>{
  const item=await asset(db,user,id,{lock:true,upload:action!=='discard'});
  if(action==='discard'){
   if(item.uploader!==user.id)fail('Imagem de outro operador.',403);
   if(await one(db,'select id from quick_replies where asset=$1',[id]))fail('Imagem vinculada a uma resposta rápida.',409);
   await db.query('delete from quick_reply_assets where id=$1 and tenant=$2',[id,user.tenant]);return {ok:true};
  }
  if(action==='part'){
   const count=Math.ceil(item.size/CHUNK),part=input.part,expected=Math.min(CHUNK,item.size-part*CHUNK);
   if(!Number.isInteger(part)||part<0||part>=count||typeof input.data!=='string'||input.data.length>Math.ceil(CHUNK/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))fail('Parte da imagem inválida.');
   const bytes=Buffer.from(input.data,'base64');if(bytes.length!==expected||bytes.toString('base64')!==input.data)fail('Tamanho da imagem inválido.');
   if(part===0)checkFileHeader(item.mime,bytes);
   await db.query('insert into quick_reply_parts(asset,part,secret) values($1,$2,$3) on conflict(asset,part) do update set secret=excluded.secret',[id,part,seal(input.data)]);
  }else{
   const parts=(await db.query('select part from quick_reply_parts where asset=$1 order by part',[id])).rows;
   if(parts.length!==Math.ceil(item.size/CHUNK)||parts.some((p,i)=>p.part!==i))fail('Upload incompleto. Envie a imagem novamente.');
   await db.query('update quick_reply_assets set ready=true where id=$1',[id]);
  }return {ok:true};
 });}
 async function image(user,id){access(user);const item=await asset(pool,user,id);
  if(!item.ready)fail('Imagem ainda não disponível.',409);
  if(!await one(pool,'select id from quick_replies where asset=$1 and tenant=$2',[id,user.tenant])&&item.uploader!==user.id)fail('Imagem não disponível.',403);
  const parts=(await pool.query('select secret from quick_reply_parts where asset=$1 order by part',[id])).rows;
  const bytes=Buffer.concat(parts.map(p=>Buffer.from(open(p.secret),'base64')));
  return new Response(bytes,{headers:{'content-type':item.mime,'content-length':String(bytes.length),'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"}});
 }
 async function route(user,path,method,input={}){
  if(path==='/api/quick-replies'){if(method==='GET')return list(user);if(method==='POST')return save(user,input);}
  if(path==='/api/quick-replies/assets'&&method==='POST')return begin(user,input);
  const media=path.match(/^\/api\/quick-replies\/assets\/([^/]+)(?:\/(part|finish|discard))?$/);
  if(media){if(!media[2]&&method==='GET')return image(user,media[1]);if(media[2]&&method==='POST')return upload(user,media[1],media[2],input);}
  const deletion=path.match(/^\/api\/quick-replies\/([^/]+)\/delete$/);if(deletion&&method==='POST')return remove(user,deletion[1],input);
  fail('Operação não encontrada.',404);
 }
 return {route};
}
