import {createQrClient,qrConfiguration,qrInboundPayload} from '../lib/whatsapp-qr.mjs';
import {isQrAccount,requiresServiceWindow,validQrSignature} from '../lib/qr-protocol.mjs';
import {createWhatsAppContent} from '../lib/whatsapp-content.mjs';
import {whatsappMediaResponse} from '../lib/whatsapp-media.mjs';
import {createReplyAttachments,mediaPayload} from '../lib/reply-attachments.mjs';
import {metaInboundResponse} from '../lib/inbound-media.mjs';
import {inboundMediaDiagnostics} from '../lib/inbound-media-diagnostics.mjs';
import {metaSendError} from '../public/meta-send-errors.mjs';
import {alertSchedulerStatus} from '../lib/alert-scheduler.mjs';
import { randomBytes, randomUUID, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { pool } from '../lib/database.mjs';
import { hash, verify } from '../lib/passwords.mjs';
import { inspectMetaAccount, inspectWhatsAppWindow } from '../lib/meta-diagnostics.mjs';
import { signedReply, customerProfile, forwardingAllowed,forwardingPhone } from '../lib/sac.mjs';
import {normalizeForwardingSettings} from '../public/service-hours-policy.mjs';
import {sameWhatsAppPhone} from '../lib/whatsapp-phone.mjs';
import { createInboundHandler } from '../lib/sac-inbound.mjs';
import { createCrm } from '../lib/crm-store.mjs';
import {createAttendance} from '../lib/attendance-store.mjs';
import {seesAttendance,worksAttendance,managesAttendance,canReplyAttendance} from '../lib/attendance-policy.mjs';
import {createWaitingAlerts,alertSettings,authorizedAlertJob} from '../lib/waiting-alerts.mjs';
import {knownWhatsAppRecipient} from '../lib/whatsapp-phone.mjs';

const IDS={instagram:'c3d707af-29a4-4e26-b8fd-ce271e7d33ee',messenger:'7b4a8a24-5bd9-4e57-bf2e-38871f3a18e7',whatsapp:'8ad045e9-798f-40cf-ab37-0ee15d26a85e'};
const META_APP_ID=process.env.META_APP_ID||'1062549136589562';
const now=()=>Date.now(),id=()=>randomUUID();
const qrClient=createQrClient();
const usesQr=a=>isQrAccount(a,open),needsWindow=a=>requiresServiceWindow(a,open);
const parameters=v=>v.map(x=>Array.isArray(x)?JSON.stringify(x):x);
const rows=async(sql,v=[])=>(await pool.query(sql,parameters(v))).rows;
const one=async(sql,v=[])=>(await pool.query(sql,parameters(v))).rows[0];
const run=(sql,v=[])=>pool.query(sql,parameters(v));
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function required(v,label,max=200){if(typeof v!=='string'||!v.trim()||v.length>max)fail(`${label} inválido.`);return v.trim();}
function email(v){v=required(v,'E-mail').toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))fail('E-mail inválido.');return v;}
function password(v){if(typeof v!=='string'||v.length<12||v.length>200)fail('A senha deve ter de 12 a 200 caracteres.');return v;}
function phone(v){v=required(v,'Telefone').replace(/\D/g,'');if(!/^\d{10,15}$/.test(v))fail('Use telefone com código do país.');return v;}
const key=()=>{const k=Buffer.from(process.env.APP_ENCRYPTION_KEY||'','base64');if(k.length!==32)throw Error('APP_ENCRYPTION_KEY inválida.');return k;};
function seal(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv),body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
function open(value){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
const digest=v=>createHash('sha256').update(v).digest('hex');
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
const permitted=(u,a)=>u.tenant===a.tenant&&(u.role==='admin'||(u.accounts||[]).includes(a.id));
async function getAccount(u,aid){const a=await one('select * from accounts where id=$1',[aid]);if(!a||!permitted(u,a))fail('Conta não disponível para este usuário.',403);return a;}
async function getConversation(u,cid){if(!/^[0-9a-f-]{36}$/i.test(cid))fail('Atendimento inválido.');const c=await one('select * from conversations where id=$1 and tenant=$2',[cid,u.tenant]);if(!c)fail('Conversa não encontrada.',404);await getAccount(u,c.account);if(!seesAttendance(u,c))fail('Atendimento de outro operador.',403);return c;}
const admin=u=>{if(u.role!=='admin')fail('Apenas administradores podem realizar esta ação.',403);};
async function validateForwardingTarget(user,account,bridge,destination){
  const sender=bridge?await getAccount(user,bridge):account.channel==='whatsapp'?account:null;
  if(!sender||sender.channel!=='whatsapp'||sender.mode!=='live'||account.mode!=='live')fail('O canal e a conta WhatsApp de envio precisam estar ativos.');
  if(usesQr(sender)){const status=await qrClient.status(sender);if(status.phone&&sameWhatsAppPhone(status.phone,destination))fail('O destino deve ser diferente do número conectado a esta conta WhatsApp.');}
  return sender;
}
const audit=(tenant,action)=>run('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[id(),tenant,action,now()]);
async function sendMeta(a,recipient,body,attachmentId,idempotencyKey){
  if(a.channel==='whatsapp'){const tenant=await one('select phone from tenants where id=$1',[a.tenant]);recipient=knownWhatsAppRecipient(recipient,tenant?.phone);}
  const media=attachmentId?await replyAttachments.delivery(attachmentId):null;
  if(usesQr(a))return qrClient.send(a,recipient,body,media?{url:media.url,kind:media.item.kind,mime:media.item.mime,name:media.item.name}:null,idempotencyKey);
  const s=open(a.secret),payload=media?mediaPayload(a.channel,recipient,media.item,media.url):a.channel==='whatsapp'
    ?{messaging_product:'whatsapp',to:recipient,type:'text',text:{body}}
    :{recipient:{id:recipient},message:{text:body},...(a.channel==='messenger'?{messaging_type:'RESPONSE'}:{})};
  const host=a.channel==='instagram'?'graph.instagram.com':'graph.facebook.com';
  const response=await fetch(`https://${host}/${s.version||'v26.0'}/${encodeURIComponent(a.channel==='instagram'?(s.instagramApiId||a.external):a.external)}/messages`,{method:'POST',headers:{Authorization:`Bearer ${s.token}`,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(Error(metaSendError(a.channel,response.status,result.error?.code)),{status:502,definite:response.status<500});
  const external=result.messages?.[0]?.id||result.message_id;
  if(!external)throw Object.assign(Error('A API não retornou identificador de entrega.'),{status:502});
  return external;
}
async function configureWhatsAppWebhook(aid,secrets){
  const origin=(process.env.PUBLIC_ORIGIN||'https://acquarella-comunicacao.vercel.app').replace(/\/$/,'');
  const form=new URLSearchParams({object:'whatsapp_business_account',callback_url:`${origin}/webhooks/meta/${aid}`,fields:'messages',verify_token:secrets.verifyToken,access_token:`${META_APP_ID}|${secrets.appSecret}`});
  const subscription=await fetch(`https://graph.facebook.com/v26.0/${META_APP_ID}/subscriptions`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(15000)});
  const subscriptionResult=await subscription.json().catch(()=>({}));
  if(!subscription.ok||!subscriptionResult.success)throw Object.assign(Error(`A Meta recusou o webhook do WhatsApp (HTTP ${subscription.status}, código ${subscriptionResult.error?.code||'desconhecido'}).`),{status:502});
  const waba=process.env.WHATSAPP_WABA_ID||'2509343702892515';
  const enrollment=await fetch(`https://graph.facebook.com/v26.0/${waba}/subscribed_apps`,{method:'POST',headers:{Authorization:`Bearer ${secrets.token}`},signal:AbortSignal.timeout(15000)});
  const enrollmentResult=await enrollment.json().catch(()=>({}));
  if(!enrollment.ok||!enrollmentResult.success)throw Object.assign(Error(`A Meta recusou a inscrição da conta WhatsApp (HTTP ${enrollment.status}, código ${enrollmentResult.error?.code||'desconhecido'}).`),{status:502});
}
async function configureInstagramWebhook(external,secrets){
  const version=secrets.version||'v26.0',headers={Authorization:`Bearer ${secrets.token}`};
  const profile=await fetch(`https://graph.instagram.com/${version}/me?fields=id,user_id,username`,{headers,signal:AbortSignal.timeout(15000)});
  const profileResult=await profile.json().catch(()=>({}));
  if(!profile.ok)throw Object.assign(Error(`A Meta recusou o token do Instagram (HTTP ${profile.status}, código ${profileResult.error?.code||'desconhecido'}).`),{status:502});
  const identities=[...new Set([profileResult.id,profileResult.user_id].filter(Boolean).map(String))];
  if(!profileResult.id||!identities.includes(String(external)))throw Object.assign(Error(`O token pertence à conta ${identities.join(' / ')||'desconhecida'}, mas o ID informado é ${external}.`),{status:422});
  const form=new URLSearchParams({subscribed_fields:'messages,messaging_referral'});
  const enrollment=await fetch(`https://graph.instagram.com/${version}/${encodeURIComponent(profileResult.id)}/subscribed_apps`,{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(15000)});
  const enrollmentResult=await enrollment.json().catch(()=>({}));
  if(!enrollment.ok||!enrollmentResult.success)throw Object.assign(Error(`A Meta recusou a assinatura de mensagens do Instagram (HTTP ${enrollment.status}, código ${enrollmentResult.error?.code||'desconhecido'}).`),{status:502});
  secrets.instagramIds=identities;
  secrets.instagramApiId=String(profileResult.id);
}
async function queue(a,c,message,kind,recipient,body){await run("insert into jobs(id,tenant,account,conversation,message,kind,recipient,body,state,error,created) values($1,$2,$3,$4,$5,$6,$7,$8,'pending','',$9)",[id(),a.tenant,a.id,c.id,message,kind,recipient,body,now()]);}
async function drainJobs(tenant){
  const jobs=await rows("select * from jobs where tenant=$1 and state='pending' and kind in ('reply','forward') order by created limit 10",[tenant]);
  for(const job of jobs){
    const a=await one('select * from accounts where id=$1',[job.account]);
    try{
      if(!a||a.mode!=='live')throw Object.assign(Error('Conta desativada para envios reais.'),{definite:true});
      const c=await one('select * from conversations where id=$1',[job.conversation]);
      if(job.kind==='reply'&&needsWindow(a)&&now()-Number(c.last_inbound)>86400000)throw Object.assign(Error('Janela de resposta de 24 horas encerrada.'),{definite:true});
      if(job.kind==='forward'){
        const tenantRow=await one('select * from tenants where id=$1',[a.tenant]);
        const origin=await one('select * from accounts where id=$1',[c.account]);
        const source=job.message&&await one('select created from messages where id=$1',[job.message]);
        if(!origin||!forwardingAllowed(origin,a,c.customer,tenantRow.phone,source?.created||job.created)){await run("update jobs set state='cancelled',error='Encaminhamento desativado ou fora do período escolhido.' where id=$1 and state='pending'",[job.id]);continue;}
        if(!sameWhatsAppPhone(forwardingPhone(origin,tenantRow.phone),job.recipient))throw Object.assign(Error('Destino do encaminhamento foi alterado.'),{definite:true});
        const window=await one('select * from bridge_windows where account=$1 and phone=$2',[a.id,job.recipient]);
        if(needsWindow(a)&&(!window||now()-Number(window.seen)>86400000))throw Object.assign(Error('A equipe precisa enviar uma mensagem ao número da API para abrir a janela de 24 horas.'),{definite:true});
      }
      const claimed=await one("update jobs set state='sending' where id=$1 and state='pending' returning id",[job.id]);
      if(!claimed)continue;
      const message=job.kind==='reply'&&job.message?await one('select media from messages where id=$1',[job.message]):null;
      const external=await sendMeta(a,job.recipient,job.body,message?.media?.attachmentId,job.id);
      await run("update jobs set state='sent',external=$1 where id=$2",[external,job.id]);
      if(job.kind==='reply'&&job.message)await run("update messages set state='sent',external=$1 where id=$2",[external,job.message]);
    }catch(error){
      const state=error.definite?'failed':'uncertain';
      await run('update jobs set state=$1,error=$2 where id=$3',[state,String(error.message||error).slice(0,500),job.id]);
      if(job.kind==='reply'&&job.message)await run('update messages set state=$1 where id=$2',[state,job.message]);
      await audit(job.tenant,`Falha no envio ${job.kind}: ${String(error.message||error).slice(0,180)}`);
    }
  }
}
async function seedAccounts(tenant){
  const common={appSecret:process.env.META_APP_SECRET||'',version:'v26.0'};
  const data=[
    [IDS.instagram,'neversonrlcarro','instagram',process.env.INSTAGRAM_ACCOUNT_ID||'',seal({...common,token:process.env.INSTAGRAM_ACCESS_TOKEN||'',verifyToken:process.env.INSTAGRAM_VERIFY_TOKEN||''}),process.env.INSTAGRAM_ACCESS_TOKEN?'live':'demo',null],
    [IDS.messenger,'Acquarella Comunicação','messenger',process.env.MESSENGER_PAGE_ID||'1295897783615114',seal({...common,token:process.env.MESSENGER_PAGE_TOKEN||'',verifyToken:process.env.MESSENGER_VERIFY_TOKEN||''}),process.env.MESSENGER_PAGE_TOKEN?'live':'demo',null],
    [IDS.whatsapp,'WhatsApp da equipe','whatsapp','',seal({token:'',appSecret:'',version:'v26.0',verifyToken:randomBytes(24).toString('hex')}),'demo',null]
  ];
  for(const a of data)await run('insert into accounts(id,tenant,name,channel,external,secret,mode,bridge) values($1,$2,$3,$4,$5,$6,$7,$8)',[a[0],tenant,...a.slice(1)]);
}
async function userFrom(request){const sid=(request.headers.get('cookie')||'').match(/(?:^|; )session=([^;]+)/)?.[1]||'';if(!sid)return null;return one('select u.* from sessions s join users u on u.id=s."user" where s.id=$1 and s.expires>$2',[digest(sid),now()]);}
const safeAccount=a=>{const s=open(a.secret);return {...a,secret:undefined,transport:s.transport||'meta',qrAvailable:!!process.env.WHATSAPP_QR_URL,configured:s.transport==='qr'?!!process.env.WHATSAPP_QR_URL:!!s.token,version:s.version||'v26.0',verifyToken:s.verifyToken,webhook:`/webhooks/meta/${a.id}`};};
const crm=createCrm({pool,permitted,open,seal,now});
const processWaitingAlerts=createWaitingAlerts({pool,send:(a,to,body,key)=>sendMeta(a,to,body,null,key),now,requiresWindow:needsWindow});
const attendance=createAttendance({pool,permitted,now});
const whatsappContent=createWhatsAppContent({pool});
const replyAttachments=createReplyAttachments({pool,seal,open,key,now,origin:()=>(process.env.PUBLIC_ORIGIN||'https://acquarella-comunicacao.vercel.app').replace(/\/$/,'')});
const processInbound=createInboundHandler({one,run,id,now,open,requiresWindow:needsWindow,profile:(a,customer)=>customerProfile(a,open(a.secret),customer),send:sendMeta,queue,audit,capture:crm.capture,captureReferral:crm.captureReferral,captureReaction:whatsappContent.captureReaction,forwardRecipients:async a=>(await rows("select forwarding_phone from accounts where tenant=$1 and forwarding_enabled and (bridge=$2 or (id=$2 and bridge is null))",[a.tenant,a.id])).map(source=>source.forwarding_phone).filter(Boolean),alertRecipients:async a=>(await rows("select alerts_phones from accounts where tenant=$1 and (bridge=$2 or (id=$2 and bridge is null))",[a.tenant,a.id])).flatMap(source=>source.alerts_phones)});
async function webhook(request,url,path){
  const aid=path.split('/').pop();let a=await one('select * from accounts where id=$1',[aid]),s;
  if(a&&usesQr(a))fail('Este canal recebe eventos pelo serviço QR.',404);
  if(a)s=open(a.secret);else if(aid===IDS.instagram){a={id:aid,external:process.env.INSTAGRAM_ACCOUNT_ID||''};s={verifyToken:process.env.INSTAGRAM_VERIFY_TOKEN||'',appSecret:process.env.META_APP_SECRET||''};}else if(aid===IDS.messenger){a={id:aid,external:process.env.MESSENGER_PAGE_ID||''};s={verifyToken:process.env.MESSENGER_VERIFY_TOKEN||'',appSecret:process.env.META_APP_SECRET||''};}else fail('Não encontrado.',404);
  if(request.method==='GET'){if(url.searchParams.get('hub.mode')==='subscribe'&&s.verifyToken===url.searchParams.get('hub.verify_token'))return new Response(url.searchParams.get('hub.challenge')||'');fail('Verificação recusada.',403);}
  if(request.method!=='POST')fail('Método inválido.',405);const raw=await request.text();if(raw.length>1048576)fail('Conteúdo muito grande.',413);const signature=request.headers.get('x-hub-signature-256')||'',expected='sha256='+createHmac('sha256',s.appSecret).update(raw).digest('hex');if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))fail('Assinatura inválida.',403);let payload;try{payload=JSON.parse(raw);}catch{fail('JSON inválido.');}if(!a.tenant)return json({received:true});const eid=digest(a.id+raw),fresh=await one('insert into events(id,tenant,payload,state,error,created) values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing returning id',[eid,a.tenant,payload,'received','',now()]);if(fresh){await processInbound(a,payload);await run("update events set state='done' where id=$1",[eid]);await drainJobs(a.tenant);}return json({received:true});
}
async function api(request,url,path){
  const deliveryPath=path.match(/^\/api\/attachments\/([0-9a-f-]{36})\/delivery$/i);
  if(deliveryPath&&['GET','HEAD'].includes(request.method)){
    if(!replyAttachments.validSignature(deliveryPath[1],url.searchParams.get('expires'),url.searchParams.get('signature')))fail('Link expirado ou inválido.',403);
    const response=await replyAttachments.response(deliveryPath[1],{range:request.headers.get('range'),publicDelivery:true});
    if(request.method==='HEAD'){await response.body.cancel();return new Response(null,{status:response.status,headers:response.headers});}return response;
  }
  if(path==='/api/internal/waiting-alerts'){if(request.method!=='GET')fail('Método inválido.',405);if(!authorizedAlertJob(request.headers.get('authorization'),process.env.CRON_SECRET))fail('Não autorizado.',401);return json(url.searchParams.get('status')==='1'?await alertSchedulerStatus(pool):await processWaitingAlerts());}
  if(!['GET','HEAD'].includes(request.method)){if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin)fail('Origem não autorizada.',403);if(request.headers.get('sec-fetch-site')==='cross-site')fail('Origem não autorizada.',403);if(!request.headers.get('content-type')?.startsWith('application/json'))fail('Use application/json.',415);}
  let input={};if(['POST','PUT','PATCH'].includes(request.method)){try{input=await request.json();}catch{fail('JSON inválido.');}}
  if(path==='/api/login'&&request.method==='POST'){
    const address=request.headers.get('x-vercel-forwarded-for')||request.headers.get('x-forwarded-for')?.split(',')[0]||'unknown';
    const buckets=[[`email:${email(input.email)}`,20],[`ip:${address}`,100]];
    await run('delete from login_limits where expires<$1',[now()]);
    for(const [bucket,limit] of buckets){
      const counter=await one('insert into login_limits(id,attempts,expires) values($1,1,$2) on conflict(id) do update set attempts=login_limits.attempts+1 returning attempts',[digest(bucket),now()+900000]);
      if(counter.attempts>limit)fail('Muitas tentativas. Aguarde 15 minutos e tente novamente.',429);
    }
  }
  if(path==='/api/bootstrap'&&request.method==='GET')return json({setup:!(await one('select id from users limit 1'))});
  if(path==='/api/setup'&&request.method==='POST'){
    if(await one('select id from users limit 1'))fail('Configuração inicial já concluída.',409);const t=id(),u=id();const client=await pool.connect();try{await client.query('begin');await client.query('insert into tenants(id,name,phone) values($1,$2,$3)',[t,required(input.company,'Empresa'),'5534988748139']);await client.query('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[u,t,required(input.name,'Nome'),email(input.email),hash(password(input.password)),'admin',[]]);await client.query('commit');}catch(e){await client.query('rollback');throw e;}finally{client.release();}await seedAccounts(t);return json({ok:true},201);
  }
  if(path==='/api/login'&&request.method==='POST'){const u=await one('select * from users where email=$1',[email(input.email)]);if(!u||typeof input.password!=='string'||!verify(input.password,u.hash))fail('E-mail ou senha inválidos.',401);const sid=randomBytes(32).toString('hex');await run('insert into sessions(id,"user",expires) values($1,$2,$3)',[digest(sid),u.id,now()+28800000]);return json({ok:true},200,{'set-cookie':`session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`});}
  const user=await userFrom(request);if(!user)fail('Faça login para continuar.',401);const sid=(request.headers.get('cookie')||'').match(/(?:^|; )session=([^;]+)/)?.[1]||'',sh=digest(sid);
  const mediaPath=path.match(/^\/api\/messages\/([0-9a-f-]{36})\/media$/i);
  const mediaDiagnosticPath=path.match(/^\/api\/conversations\/([^/]+)\/media-diagnostics$/);
  if(mediaDiagnosticPath&&request.method==='GET'){admin(user);const conversation=await getConversation(user,mediaDiagnosticPath[1]),account=await getAccount(user,conversation.account);return json(await inboundMediaDiagnostics({pool,conversation,account}));}
  if(mediaPath&&['GET','HEAD'].includes(request.method)){
    const message=await one('select * from messages where id=$1',[mediaPath[1]]);if(!message)fail('Anexo não encontrado.',404);
    const conversation=await getConversation(user,message.conversation),account=await getAccount(user,conversation.account);
    const range=request.headers.get('range')||(request.method==='HEAD'?'bytes=0-0':null);
    const respond=async pending=>{const response=await pending;if(request.method==='HEAD'){await response.body?.cancel();return new Response(null,{status:response.status,headers:response.headers});}return response;};
    if(message.media?.attachmentId)return respond(replyAttachments.response(message.media.attachmentId,{range,download:url.searchParams.get('download')==='1',preview:url.searchParams.get('preview')==='1'}));
    if(message.media?.qrId){if(!usesQr(account))fail('Anexo QR indisponível.',404);return respond(qrClient.media(account,message,{range,download:url.searchParams.get('download')==='1',preview:url.searchParams.get('preview')==='1'}));}
    if(message.media?.items){
      const index=Number(url.searchParams.get('attachment')||0);if(!Number.isInteger(index)||index<0||index>19)fail('Anexo inválido.');
      return respond(metaInboundResponse({account,secrets:open(account.secret),message,index,range,download:url.searchParams.get('download')==='1',preview:url.searchParams.get('preview')==='1',save:async parsed=>run('update messages set kind=$1,media=$2 where id=$3',[parsed.kind,JSON.stringify(parsed.media),message.id])}));
    }
    return respond(whatsappMediaResponse({account,secrets:open(account.secret),message,range,download:url.searchParams.get('download')==='1',preview:url.searchParams.get('preview')==='1'}));
  }
  const uploadPath=path.match(/^\/api\/conversations\/([^/]+)\/attachments(?:\/([0-9a-f-]{36})\/(part|finish|remove))?$/i);
  if(uploadPath&&request.method==='POST'){
    const c=await getConversation(user,uploadPath[1]),a=await getAccount(user,c.account);
    if(user.role==='viewer'||!canReplyAttendance(user,c))fail('Assuma um atendimento aberto antes de anexar.',403);
    if(a.mode==='live'&&needsWindow(a)&&now()-Number(c.last_inbound)>86400000)fail('A janela de resposta de 24 horas está encerrada.');
    return json(uploadPath[3]?await replyAttachments[uploadPath[3]](user,c,uploadPath[2],input):await replyAttachments.begin(user,c,a,input));
  }
  const diagnosticPath=path.match(/^\/api\/accounts\/([^/]+)\/diagnostics$/);
  const attendancePath=path.match(/^\/api\/conversations\/([^/]+)\/(claim|transfer)$/);
  if(attendancePath&&request.method==='POST'){const c=await getConversation(user,attendancePath[1]);return json(attendancePath[2]==='claim'?await attendance.claim(user,c.id):await attendance.transfer(user,c.id,input));}
  if(path==='/api/crm/state'&&request.method==='GET')return json(await crm.state(user));
  if(path.startsWith('/api/crm/')&&request.method==='POST')return json(await crm.route(user,path,input));
  const qrPath=path.match(/^\/api\/accounts\/([^/]+)\/qr(?:\/(connect|disconnect))?$/);
  if(qrPath){admin(user);const account=await getAccount(user,qrPath[1]);if(!usesQr(account)||account.mode!=='live')fail('Selecione um canal WhatsApp por QR Code ativo.');const action=qrPath[2];if((!action&&request.method!=='GET')||(action&&request.method!=='POST'))fail('Método inválido.',405);const result=await qrClient[action||'status'](account);if(action)await audit(user.tenant,`Conexão QR de ${account.name}: ${action==='connect'?'iniciada':'desconectada'} por ${user.name}.`);return json(result);}
  if(diagnosticPath&&request.method==='GET'){admin(user);const account=await getAccount(user,diagnosticPath[1]);if(usesQr(account))return json(await qrClient.status(account));const result=await inspectMetaAccount(account,open(account.secret));if(account.channel==='whatsapp'){const tenant=await one('select phone from tenants where id=$1',[user.tenant]);const window=await one('select seen from bridge_windows where account=$1 and phone=$2',[account.id,tenant.phone]);result.teamWindow=inspectWhatsAppWindow(window?.seen);}return json(result);}
  const alertsPath=path.match(/^\/api\/accounts\/([^/]+)\/alerts$/);
  if(alertsPath&&request.method==='POST'){
    admin(user);const account=await getAccount(user,alertsPath[1]),settings=alertSettings(input,account);
    const bridge=input.bridge===undefined?account.bridge:String(input.bridge||'')||null;
    const sender=bridge?await getAccount(user,bridge):account.channel==='whatsapp'?account:null;
    if(bridge&&sender.channel!=='whatsapp')fail('Selecione uma conta WhatsApp para os alertas.');
    if(settings.enabled&&(!sender||sender.mode!=='live'))fail('Selecione uma conta WhatsApp em API real para enviar os alertas.');
    if(account.forwarding_enabled&&!bridge&&account.channel!=='whatsapp')fail('Mantenha uma conta WhatsApp enquanto o encaminhamento estiver ativo.');
    await run('update accounts set bridge=$2,alerts_enabled=$3,queue_alert_minutes=$4,assigned_alert_minutes=$5,alerts_phones=$6 where id=$1',[account.id,bridge,settings.enabled,settings.queue,settings.assigned,settings.phones]);
    await audit(user.tenant,`Alertas de ${account.name} ${settings.enabled?'ativados':'desativados'} por ${user.name}: fila ${settings.queue} min, atribuídos ${settings.assigned} min.`);
    return json({ok:true});
  }
  const routingPath=path.match(/^\/api\/accounts\/([^/]+)\/routing$/);
  if(routingPath&&request.method==='POST'){admin(user);const account=await getAccount(user,routingPath[1]);if(typeof input.enabled!=='boolean')fail('Estado de encaminhamento inválido.');if(input.enabled&&!account.bridge&&account.channel!=='whatsapp')fail('Selecione uma conta WhatsApp em Configurar conta.');if(input.enabled){normalizeForwardingSettings({},account);if(!account.bridge&&!account.forwarding_phone)fail('Configure o telefone de destino em Horários e encaminhamento.');const tenant=await one('select phone from tenants where id=$1',[user.tenant]);await validateForwardingTarget(user,account,account.bridge,forwardingPhone(account,tenant.phone));}await run('update accounts set forwarding_enabled=$1 where id=$2',[input.enabled,account.id]);if(!input.enabled)await run("update jobs set state='cancelled',error='Encaminhamento desativado.' where tenant=$1 and kind='forward' and state='pending' and conversation in (select id from conversations where account=$2)",[user.tenant,account.id]);await audit(user.tenant,`Encaminhamento de ${account.name} ${input.enabled?'ativado':'desativado'} por ${user.name}.`);return json({ok:true});}
  const hoursPath=path.match(/^\/api\/accounts\/([^/]+)\/service-hours$/);
  if(hoursPath&&request.method==='POST'){
    admin(user);const account=await getAccount(user,hoursPath[1]),settings=normalizeForwardingSettings(input,account);
    if(typeof input.forwardingEnabled!=='boolean')fail('Estado de encaminhamento inválido.');
    const bridge=input.bridge===undefined?account.bridge:String(input.bridge||'')||null;
    const sender=bridge?await getAccount(user,bridge):account.channel==='whatsapp'?account:null;
    if(bridge&&sender.channel!=='whatsapp')fail('Selecione uma conta WhatsApp para encaminhar.');
    if(input.forwardingEnabled){
      if(!settings.phone)fail('Informe o telefone WhatsApp de destino.');
      await validateForwardingTarget(user,account,bridge,settings.phone);
    }
    if(account.alerts_enabled&&(!sender||sender.mode!=='live'))fail('Mantenha uma conta WhatsApp ativa para os alertas.');
    await run('update accounts set service_hours=$2,forwarding_phone=$3,forwarding_period=$4,forwarding_enabled=$5,bridge=$6 where id=$1',[account.id,JSON.stringify(settings.hours),settings.phone,settings.period,input.forwardingEnabled,bridge]);
    await run("update jobs set state='cancelled',error='Configuração de encaminhamento alterada.' where tenant=$1 and kind='forward' and state='pending' and conversation in (select id from conversations where account=$2)",[user.tenant,account.id]);
    await audit(user.tenant,`Horários e encaminhamento de ${account.name} atualizados por ${user.name}.`);
    return json({ok:true});
  }
  const contactPath=path.match(/^\/api\/conversations\/([^/]+)\/contact$/);
  if(contactPath&&request.method==='POST'){if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);const c=await getConversation(user,contactPath[1]);if(!worksAttendance(user,c))fail('Assuma o atendimento antes de identificar o cliente.',403);if(input.action==='refresh'){const a=await getAccount(user,c.account),identity=await customerProfile(a,open(a.secret),c.customer);if(!identity.name&&!identity.username)fail('A Meta não disponibilizou o nome deste cliente. Você pode identificá-lo manualmente.',422);await run("update conversations set name=case when name_manual then name else $1 end,username=$2,profile_checked=$3 where id=$4",[identity.name||identity.username,identity.username||'',now(),c.id]);}else{await run('update conversations set name=$1,name_manual=true where id=$2',[required(input.name,'Nome do cliente'),c.id]);}return json({ok:true});}
  if(path==='/api/logout'&&request.method==='POST'){await run('delete from sessions where id=$1',[sh]);return json({ok:true},200,{'set-cookie':'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});}
  if(path==='/api/state'&&request.method==='GET'){const snapshotTime=now();let accounts=(await rows('select * from accounts where tenant=$1',[user.tenant])).filter(a=>permitted(user,a)),allowed=new Set(accounts.map(a=>a.id));const conversations=(await rows('select * from conversations where tenant=$1 order by updated desc',[user.tenant])).filter(c=>allowed.has(c.account)&&seesAttendance(user,c));for(const c of conversations){c.messages=await rows("select * from messages where conversation=$1 and kind<>'reaction' order by created",[c.id]);const reactions=await whatsappContent.reactions(c);for(const m of c.messages)m.reactions=reactions.filter(r=>r.target_external===m.external||c.account+':'+r.target_external===m.external);c.attendance_history=await rows('select * from attendance_history where conversation=$1 and tenant=$2 order by created desc limit 50',[c.id,user.tenant]);c.assignee_name=c.assigned_to?(await one('select name from users where id=$1',[c.assigned_to]))?.name:null;}return json({server_time:snapshotTime,user:{id:user.id,name:user.name,email:user.email,role:user.role},tenant:await one('select * from tenants where id=$1',[user.tenant]),accounts:accounts.map(a=>user.role==='admin'?safeAccount(a):{id:a.id,name:a.name,channel:a.channel,mode:a.mode,bridge:a.bridge,forwarding_enabled:a.forwarding_enabled,service_hours:a.service_hours,forwarding_phone:a.forwarding_phone,forwarding_period:a.forwarding_period}),conversations,users:user.role==='admin'?await rows('select id,name,email,role,accounts from users where tenant=$1',[user.tenant]):[],audit:user.role==='admin'?await rows('select * from audit where tenant=$1 order by created desc limit 50',[user.tenant]):[],jobs:user.role==='admin'?await rows('select j.id,j.kind,j.state,j.error,j.created,j.recipient,a.name as source_name from jobs j left join accounts a on a.id=j.alert_source and a.tenant=j.tenant where j.tenant=$1 order by j.created desc limit 50',[user.tenant]):[]});}
  if(path==='/api/accounts'&&request.method==='POST'){
    admin(user);
    const old=input.id?await getAccount(user,input.id):null,channel=old?.channel||input.channel;
    if(!['instagram','messenger','whatsapp'].includes(channel))fail('Canal inválido.');
    const alerts=alertSettings(input,old),secrets=old?open(old.secret):{verifyToken:randomBytes(24).toString('hex')};
    const transport=channel==='whatsapp'?(input.transport||secrets.transport||'meta'):'meta';
    if(!['meta','qr'].includes(transport))fail('Forma de conexão inválida.');
    if(old&&(secrets.transport||'meta')!==transport)fail('Adicione outro canal para mudar a forma de conexão e preservar o histórico.');
    secrets.transport=transport;
    for(const k of ['token','appSecret','version'])if(input[k])secrets[k]=required(input[k],k,2000);
    if(channel==='whatsapp'&&transport==='meta'){
      const sibling=await one("select secret from accounts where tenant=$1 and channel='messenger' and mode='live' limit 1",[user.tenant]);
      if(sibling)secrets.appSecret=open(sibling.secret).appSecret||secrets.appSecret||'';
    }
    secrets.version||='v26.0';
    const mode=input.mode==='live'?'live':'demo',aid=old?.id||id();
    const external=transport==='qr'?aid:String(input.external||'').trim();
    if(mode==='live'&&transport==='qr')qrConfiguration();
    if(mode==='live'&&transport==='meta'&&(!external||!secrets.token||!secrets.appSecret))fail('Preencha ID Meta, token e App Secret para ativar.');
    const bridge=String(input.bridge||'')||null;
    if(bridge){const b=await getAccount(user,bridge);if(b.channel!=='whatsapp')fail('Selecione uma conta WhatsApp para a ponte.');if(bridge===aid)fail('Selecione outro canal para encaminhar mensagens.');}
    const forwardingEnabled=typeof input.forwardingEnabled==='boolean'?input.forwardingEnabled:old?.forwarding_enabled??false;
    if(forwardingEnabled&&!bridge&&channel!=='whatsapp')fail('Selecione uma conta WhatsApp para encaminhar.');
    if(forwardingEnabled&&mode==='live'){if(!bridge&&!old?.forwarding_phone)fail('Configure o telefone de destino em Horários e encaminhamento.');const tenant=await one('select phone from tenants where id=$1',[user.tenant]);await validateForwardingTarget(user,{...old,id:aid,tenant:user.tenant,channel,mode,secret:seal(secrets)},bridge,old?.forwarding_phone||tenant.phone);}
    if(alerts.enabled){const sender=bridge?await getAccount(user,bridge):channel==='whatsapp'?{channel,mode}:null;if(!sender||sender.channel!=='whatsapp'||sender.mode!=='live')fail('Selecione uma conta WhatsApp ativa para enviar os alertas.');}
    if(channel==='instagram'&&mode==='live')await configureInstagramWebhook(external,secrets);
    await run('insert into accounts(id,tenant,name,channel,external,secret,mode,bridge,forwarding_enabled,alerts_enabled,queue_alert_minutes,assigned_alert_minutes,alerts_phones) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(id) do update set name=excluded.name,external=excluded.external,secret=excluded.secret,mode=excluded.mode,bridge=excluded.bridge,forwarding_enabled=excluded.forwarding_enabled,alerts_enabled=excluded.alerts_enabled,queue_alert_minutes=excluded.queue_alert_minutes,assigned_alert_minutes=excluded.assigned_alert_minutes,alerts_phones=excluded.alerts_phones',[aid,user.tenant,required(input.name,'Nome'),channel,external,seal(secrets),mode,bridge,forwardingEnabled,alerts.enabled,alerts.queue,alerts.assigned,alerts.phones]);
    if(channel==='whatsapp'&&mode==='live'&&transport==='meta')await configureWhatsAppWebhook(aid,secrets);
    await audit(user.tenant,`Conta ${input.name} configurada por ${user.name}.`);
    return json({ok:true,id:aid,transport});
  }
  if(path==='/api/users'&&request.method==='POST'){admin(user);const old=input.id?await one('select * from users where id=$1 and tenant=$2',[input.id,user.tenant]):null;if(input.id&&!old)fail('Usuário não encontrado.',404);if(!['admin','receptionist','agent','viewer'].includes(input.role))fail('Perfil inválido.');if(old?.id===user.id&&input.role!=='admin')fail('Você não pode remover seu próprio acesso administrativo.');if(!Array.isArray(input.accounts))fail('Selecione as contas permitidas.');for(const aid of input.accounts)await getAccount(user,aid);const mail=email(input.email),dupe=await one('select id from users where email=$1 and id<>$2',[mail,old?.id||id()]);if(dupe)fail('E-mail já utilizado.');const h=input.password?hash(password(input.password)):old?.hash;if(!h)fail('Defina uma senha com pelo menos 12 caracteres.');await run('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set name=excluded.name,email=excluded.email,hash=excluded.hash,role=excluded.role,accounts=excluded.accounts',[old?.id||id(),user.tenant,required(input.name,'Nome'),mail,h,input.role,input.accounts]);if(old)await run('delete from sessions where "user"=$1 and id<>$2',[old.id,sh]);await audit(user.tenant,`Permissões de ${input.name} atualizadas por ${user.name}.`);return json({ok:true});}
  if(path==='/api/tenant'&&request.method==='POST'){admin(user);await run('update tenants set name=$1,phone=$2 where id=$3',[required(input.name,'Empresa'),phone(input.phone),user.tenant]);return json({ok:true});}
  if(path==='/api/tenants'&&request.method==='POST'){admin(user);const mail=email(input.email);if(await one('select id from users where email=$1',[mail]))fail('Use um e-mail exclusivo para a nova empresa.');const t=id();await run('insert into tenants(id,name,phone) values($1,$2,$3)',[t,required(input.name,'Empresa'),phone(input.phone)]);await run('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[id(),t,required(input.adminName,'Administrador'),mail,hash(password(input.password)),'admin',[]]);return json({ok:true},201);}
  let m=path.match(/^\/api\/conversations\/([^/]+)\/status$/);if(m&&request.method==='POST'){if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);const c=await getConversation(user,m[1]);if(!['open','resolved'].includes(input.status))fail('Status inválido.');return json(await attendance.status(user,c.id,input.status,input));}
  m=path.match(/^\/api\/conversations\/([^/]+)\/reply$/);if(m&&request.method==='POST'){
    if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);
    const c=await getConversation(user,m[1]),a=await getAccount(user,c.account),body=input.attachmentId?String(input.body||'').trim():required(input.body,'Mensagem',2000),mid=id();
    if(a.mode==='live'&&c.customer.startsWith('demo-'))fail('Conversa demonstrativa não pode enviar mensagens reais.');
    let signed;try{signed=body?signedReply(user.name,body):'';}catch(error){fail(error.message);}
    if(!c.assigned_to)fail('Clique em Assumir atendimento antes de responder.',403);
    else if(!canReplyAttendance(user,c))fail('Atendimento indisponível para responder. Reabra o atendimento se estiver finalizado.',403);
    await crm.assignOnReply(c,user);
    if(input.attachmentId){
      if(a.mode==='live'&&needsWindow(a)&&now()-Number(c.last_inbound)>86400000)fail('A janela de resposta de 24 horas está encerrada.');
      const attachmentMessage=await replyAttachments.enqueue(user,c,a,input);if(a.mode==='live')await drainJobs(user.tenant);
      const result=await one('select state from messages where id=$1',[attachmentMessage]);return json({ok:true,state:result?.state});
    }
    if(a.mode==='demo'){await run("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name) values($1,$2,'out',$3,$4,'simulated',$5,$6)",[mid,c.id,body,now(),user.id,user.name]);await run('update conversations set updated=$1 where id=$2',[now(),c.id]);return json({ok:true});}
    if(needsWindow(a)&&now()-Number(c.last_inbound)>86400000)fail('A janela de resposta de 24 horas está encerrada.');
    await run("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name) values($1,$2,'out',$3,$4,'queued',$5,$6)",[mid,c.id,body,now(),user.id,user.name]);
    await queue(a,c,mid,'reply',c.customer,signed);await drainJobs(user.tenant);
    const sent=await one('select state,error from jobs where message=$1 order by created desc limit 1',[mid]);
    if(sent?.state==='failed')fail(sent.error||'Falha no envio.',502);
    await run('update conversations set updated=$1 where id=$2',[now(),c.id]);return json({ok:true});
  }
  fail('Não encontrado.',404);
}
async function qrWebhook(request,path){
  if(request.method!=='POST')fail('Método inválido.',405);
  const raw=await request.text();if(raw.length>262144)fail('Evento muito grande.',413);
  if(!validQrSignature(process.env.WHATSAPP_QR_SECRET,request.method,path,request.headers,raw))fail('Assinatura QR inválida.',403);
  let event;try{event=JSON.parse(raw);}catch{fail('JSON inválido.');}
  const aid=path.split('/').pop(),account=await one('select * from accounts where id=$1',[aid]);
  if(!account||!usesQr(account)||account.mode!=='live')fail('Canal QR indisponível.',404);
  const payload=qrInboundPayload(account,event),eid=digest(account.id+event.id);
  const existing=await one('select state from events where id=$1',[eid]);if(existing?.state==='done')return json({received:true});
  await run('insert into events(id,tenant,payload,state,error,created) values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing',[eid,account.tenant,payload,'received','',now()]);
  try{await processInbound(account,payload);await run("update events set state='done',error='' where id=$1",[eid]);}
  catch(error){await run("update events set state='failed',error='Falha no processamento QR; nova tentativa pendente.' where id=$1",[eid]);throw error;}
  await drainJobs(account.tenant);return json({received:true});
}
export default {async fetch(request){try{const url=new URL(request.url),path=url.pathname;if(/^\/webhooks\/whatsapp-qr\/[a-f0-9-]{36}$/i.test(path))return await qrWebhook(request,path);if(path.startsWith('/webhooks/meta/'))return await webhook(request,url,path);if(path.startsWith('/api/'))return await api(request,url,path);return json({error:'Não encontrado.'},404);}catch(error){console.error(error);if(error.code==='42P01')return json({error:'Banco de dados ainda não inicializado.'},503);if(error.code==='23505')return json({error:'Registro já existente.'},409);return json({error:error.status?error.message:'Erro interno da central.'},error.status||500);}}};
