import {createActiveMessageManagement} from '../lib/active-message-management.mjs';
import {createDailyActions} from '../lib/daily-actions.mjs';
import {createMercadoPagoSettings} from '../lib/mercado-pago-settings.mjs';
import {createMercadoPagoRenewals} from '../lib/mercado-pago-renewals.mjs';
import {canEditMessage,canForwardMessage} from '../lib/message-operation-policy.mjs';
import {createMessageOperations} from '../lib/message-operations.mjs';
import {resolveQuotedReply} from '../lib/quoted-reply.mjs';
import {createFinalizedAttendances} from '../lib/finalized-attendances.mjs';
import {hydrateInbox} from '../lib/inbox-snapshot.mjs';
import {validAppearance} from '../public/appearance-options.mjs';
import {replySigner} from '../lib/reply-signature.mjs';
import {createQrClient,qrConfiguration,qrInboundPayload} from '../lib/whatsapp-qr.mjs';
import {isQrAccount,requiresServiceWindow,validQrSignature} from '../lib/qr-protocol.mjs';
import {createWhatsAppContent} from '../lib/whatsapp-content.mjs';
import {canDeleteWhatsAppMessage,canReactWhatsAppMessage} from '../lib/message-deletion.mjs';
import {isWhatsAppReaction} from '../public/whatsapp-reactions.mjs';
import {whatsappMediaResponse} from '../lib/whatsapp-media.mjs';
import {createReplyAttachments,mediaPayload} from '../lib/reply-attachments.mjs';
import {createQuickReplies} from '../lib/quick-replies.mjs';
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
import {createAppointmentNotifications} from '../lib/appointment-notifications.mjs';
import {createContactDirectory} from '../lib/contact-directory.mjs';
import {createCashbarber} from '../lib/cashbarber-store.mjs';
import {createChannelRemoval} from '../lib/channel-removal.mjs';
import {createContactOutreach} from '../lib/contact-outreach.mjs';
import {knownWhatsAppRecipient} from '../lib/whatsapp-phone.mjs';
import {createChatgptConnection} from '../lib/chatgpt-connection.mjs';
import {createEvaluationWorker} from '../lib/attendance-evaluations.mjs';

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
function password(v){if(typeof v!=='string'||v.length<8||v.length>200)fail('A senha deve ter de 8 a 200 caracteres.');return v;}
function phone(v){v=required(v,'Telefone').replace(/\D/g,'');if(!/^\d{10,15}$/.test(v))fail('Use telefone com código do país.');return v;}
const key=()=>{const k=Buffer.from(process.env.APP_ENCRYPTION_KEY||'','base64');if(k.length!==32)throw Error('APP_ENCRYPTION_KEY inválida.');return k;};
function seal(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv),body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
function open(value){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
const digest=v=>createHash('sha256').update(v).digest('hex');
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra}});
const permitted=(u,a)=>u.tenant===a.tenant&&(u.role==='admin'||(u.accounts||[]).includes(a.id));
async function getAccount(u,aid){const a=await one('select * from accounts where id=$1',[aid]);if(!a||!permitted(u,a))fail('Conta não disponível para este usuário.',403);return a;}
async function getConversation(u,cid,{archived=false}={}){if(!/^[0-9a-f-]{36}$/i.test(cid))fail('Atendimento inválido.');const c=await one('select * from conversations where id=$1 and tenant=$2',[cid,u.tenant]);if(!c)fail('Conversa não encontrada.',404);await getAccount(u,c.account);if(!seesAttendance(u,c)&&!(archived&&c.status==='resolved'))fail('Atendimento de outro operador.',403);return c;}
const admin=u=>{if(u.role!=='admin')fail('Apenas administradores podem realizar esta ação.',403);};
async function validateForwardingTarget(user,account,bridge,destination){
  const sender=bridge?await getAccount(user,bridge):account.channel==='whatsapp'?account:null;
  if(!sender||sender.enabled===false||account.enabled===false||sender.channel!=='whatsapp'||sender.mode!=='live'||account.mode!=='live')fail('O canal e a conta WhatsApp de envio precisam estar ativos.');
  if(usesQr(sender)){const status=await qrClient.status(sender);if(status.phone&&sameWhatsAppPhone(status.phone,destination))fail('O destino deve ser diferente do número conectado a esta conta WhatsApp.');}
  return sender;
}
const audit=(tenant,action)=>run('insert into audit(id,tenant,action,created) values($1,$2,$3,$4)',[id(),tenant,action,now()]);
async function sendMeta(a,recipient,body,attachmentId,idempotencyKey,replyTo=null){
  if(a.enabled===false)throw Object.assign(Error('Canal desativado.'),{status:409,definite:true});
  if(a.channel==='whatsapp'){const tenant=await one('select phone from tenants where id=$1',[a.tenant]);recipient=knownWhatsAppRecipient(recipient,tenant?.phone);}
  const media=attachmentId?await replyAttachments.delivery(attachmentId):null;
  if(usesQr(a))return qrClient.send(a,recipient,body,media?{url:media.url,kind:media.item.kind,mime:media.item.mime,name:media.item.name}:null,idempotencyKey,replyTo);
  const s=open(a.secret),payload=media?mediaPayload(a.channel,recipient,media.item,media.url):a.channel==='whatsapp'
    ?{messaging_product:'whatsapp',to:recipient,type:'text',text:{body}}
    :{recipient:{id:recipient},message:{text:body},...(a.channel==='messenger'?{messaging_type:'RESPONSE'}:{})};
  if(replyTo&&a.channel==='whatsapp')payload.context={message_id:replyTo.external};
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
async function drainJobs(tenant,conversation=null){
  const jobs=await rows("select * from jobs where tenant=$1 and state='pending' and kind in ('reply','forward')"+(conversation?' and conversation=$2':'')+" order by created limit 10",conversation?[tenant,conversation]:[tenant]);
  for(const job of jobs){
    const a=await one('select * from accounts where id=$1',[job.account]);
    try{
      if(!a||a.mode!=='live'||a.enabled===false)throw Object.assign(Error('Conta desativada para envios reais.'),{definite:true});
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
      const external=await sendMeta(a,job.recipient,job.body,message?.media?.attachmentId,job.id,message?.media?.replyTo);
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
const contacts=createContactDirectory({pool,permitted,now});
const quickReplies=createQuickReplies({pool,seal,open,now});
const outreach=createContactOutreach({pool,permitted,requiresWindow:needsWindow,now});
const cashbarber=createCashbarber({pool,getConversation,audit,getCrmState:user=>crm.state(user)});
const processWaitingAlerts=createWaitingAlerts({pool,send:(a,to,body,key)=>sendMeta(a,to,body,null,key),now,requiresWindow:needsWindow});
const activeMessages=createActiveMessageManagement({pool,now});
const appointmentNotifications=createAppointmentNotifications({pool,usesQr,send:(a,to,body,key)=>sendMeta(a,to,body,null,key),now});
const {renewal,sampleCheckout}=createMercadoPagoRenewals({pool,open});
const dailyActions=createDailyActions({pool,usesQr,send:(a,to,body,key)=>sendMeta(a,to,body,null,key),now,renewal});
const attendance=createAttendance({pool,permitted,now});
const finalized=createFinalizedAttendances({pool,permitted,usesQr,now});
const aiConnection=createChatgptConnection({pool,seal,open,now});
const mercadoPagoSettings=createMercadoPagoSettings({pool,seal,sampleCheckout,now});
const processEvaluations=createEvaluationWorker({pool,connection:aiConnection,now});
const channelRemoval=createChannelRemoval({pool,permitted,usesQr,disconnect:account=>qrClient.disconnect(account),now});
const whatsappContent=createWhatsAppContent({pool});
const replyAttachments=createReplyAttachments({pool,seal,open,key,now,origin:()=>(process.env.PUBLIC_ORIGIN||'https://acquarella-comunicacao.vercel.app').replace(/\/$/,'')});
const messageOperations=createMessageOperations({pool,permitted,usesQr,qr:qrClient,attachmentDelivery:id=>replyAttachments.delivery(id),now});
const processInbound=createInboundHandler({one,run,id,now,open,requiresWindow:needsWindow,profile:(a,customer)=>customerProfile(a,open(a.secret),customer),send:sendMeta,queue,audit,capture:crm.capture,captureReferral:crm.captureReferral,captureReaction:whatsappContent.captureReaction,captureDeletion:whatsappContent.captureDeletion,forwardRecipients:async a=>(await rows("select forwarding_phone from accounts where tenant=$1 and forwarding_enabled and (bridge=$2 or (id=$2 and bridge is null))",[a.tenant,a.id])).map(source=>source.forwarding_phone).filter(Boolean),alertRecipients:async a=>(await rows("select alerts_phones from accounts where tenant=$1 and (bridge=$2 or (id=$2 and bridge is null))",[a.tenant,a.id])).flatMap(source=>source.alerts_phones)});
async function webhook(request,url,path){
  const aid=path.split('/').pop();let a=await one('select * from accounts where id=$1',[aid]),s;
  if(a&&usesQr(a))fail('Este canal recebe eventos pelo serviço QR.',404);
  if(a)s=open(a.secret);else if(aid===IDS.instagram){a={id:aid,external:process.env.INSTAGRAM_ACCOUNT_ID||''};s={verifyToken:process.env.INSTAGRAM_VERIFY_TOKEN||'',appSecret:process.env.META_APP_SECRET||''};}else if(aid===IDS.messenger){a={id:aid,external:process.env.MESSENGER_PAGE_ID||''};s={verifyToken:process.env.MESSENGER_VERIFY_TOKEN||'',appSecret:process.env.META_APP_SECRET||''};}else fail('Não encontrado.',404);
  if(request.method==='GET'){if(url.searchParams.get('hub.mode')==='subscribe'&&s.verifyToken===url.searchParams.get('hub.verify_token'))return new Response(url.searchParams.get('hub.challenge')||'');fail('Verificação recusada.',403);}
  if(request.method!=='POST')fail('Método inválido.',405);const raw=await request.text();if(raw.length>1048576)fail('Conteúdo muito grande.',413);const signature=request.headers.get('x-hub-signature-256')||'',expected='sha256='+createHmac('sha256',s.appSecret).update(raw).digest('hex');if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))fail('Assinatura inválida.',403);let payload;try{payload=JSON.parse(raw);}catch{fail('JSON inválido.');}if(!a.tenant||a.enabled===false)return json({received:true,ignored:a.enabled===false});const eid=digest(a.id+raw),fresh=await one('insert into events(id,tenant,payload,state,error,created) values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing returning id',[eid,a.tenant,payload,'received','',now()]);if(fresh){await processInbound(a,payload);await run("update events set state='done' where id=$1",[eid]);await drainJobs(a.tenant);}return json({received:true});
}
async function api(request,url,path){
  const deliveryPath=path.match(/^\/api\/attachments\/([0-9a-f-]{36})\/delivery$/i);
  if(deliveryPath&&['GET','HEAD'].includes(request.method)){
    if(!replyAttachments.validSignature(deliveryPath[1],url.searchParams.get('expires'),url.searchParams.get('signature')))fail('Link expirado ou inválido.',403);
    const response=await replyAttachments.response(deliveryPath[1],{range:request.headers.get('range'),publicDelivery:true});
    if(request.method==='HEAD'){await response.body.cancel();return new Response(null,{status:response.status,headers:response.headers});}return response;
  }
  if(path==='/api/internal/waiting-alerts'){if(request.method!=='GET')fail('Método inválido.',405);if(!authorizedAlertJob(request.headers.get('authorization'),process.env.CRON_SECRET))fail('Não autorizado.',401);if(url.searchParams.get('status')==='1')return json(await alertSchedulerStatus(pool));const daily=await dailyActions.process();const [alerts,evaluations,appointments]=await Promise.all([processWaitingAlerts(),processEvaluations(),appointmentNotifications.process()]);return json({...alerts,evaluations,appointments,daily});}
  if(path==='/api/internal/attendance-evaluations'){if(request.method!=='GET')fail('Método inválido.',405);if(!authorizedAlertJob(request.headers.get('authorization'),process.env.CRON_SECRET))fail('Não autorizado.',401);return json(await processEvaluations());}
  if(!['GET','HEAD'].includes(request.method)){if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin)fail('Origem não autorizada.',403);if(request.headers.get('sec-fetch-site')==='cross-site')fail('Origem não autorizada.',403);if(!request.headers.get('content-type')?.startsWith('application/json'))fail('Use application/json.',415);}
  let input={};if(['POST','PUT','PATCH'].includes(request.method)){try{input=await request.json();}catch{fail('JSON inválido.');}}
  if(path==='/api/ai/pairing/begin'&&request.method==='POST')return json(await aiConnection.begin(input));
  if(path==='/api/ai/pairing/complete'&&request.method==='POST')return json(await aiConnection.complete(input));
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
  const firstViewPath=path.match(/^\/api\/conversations\/([a-f0-9-]{36})\/messages\/first-view$/i);
  if(firstViewPath&&request.method==='POST'){
    const c=await getConversation(user,firstViewPath[1],{archived:true});
    if(!Array.isArray(input.ids)||input.ids.length<1||input.ids.length>100||input.ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)))fail('Mensagens inválidas.');
    const ids=[...new Set(input.ids)];
    // PostgreSQL rechecks the NULL predicate after concurrent updates, so only
    // the first authorized viewer can write this immutable timestamp/identity.
    await pool.query("update messages set first_viewed_at=$1,first_viewed_by=$2 where conversation=$3 and id=any($4::uuid[]) and direction='in' and first_viewed_at is null",[now(),user.id,c.id,ids]);
    return json({messages:(await pool.query("select id,first_viewed_at from messages where conversation=$1 and id=any($2::uuid[]) and direction='in'",[c.id,ids])).rows});
  }
  if(path==='/api/me/appearance'&&request.method==='POST'){
    if(!validAppearance(input.theme))fail('Escolha uma aparência válida.');
    await run('update users set appearance=$1 where id=$2 and tenant=$3',[input.theme,user.id,user.tenant]);
    return json({ok:true,theme:input.theme});
  }
  if(path==='/api/finalized-attendances'&&request.method==='GET')return json(await finalized.search(user,url));
  const finalizedPath=path.match(/^\/api\/finalized-attendances\/([^/]+)(\/reopen)?$/);
  if(finalizedPath){
    if(request.method==='GET'&&!finalizedPath[2])return json(await finalized.detail(user,finalizedPath[1],url));
    if(request.method==='POST'&&finalizedPath[2])return json(await finalized.reopen(user,finalizedPath[1]));
    fail('Método inválido.',405);
  }
  if(path==='/api/quick-replies'||path.startsWith('/api/quick-replies/')){const result=await quickReplies.route(user,path,request.method,input);return result instanceof Response?result:json(result);}
  if(path==='/api/ai/status'&&request.method==='GET'){admin(user);return json(await aiConnection.status(user.tenant));}
  if(path==='/api/ai/models'&&request.method==='GET'){admin(user);return json({models:await aiConnection.models(user.tenant)});}
  if(path==='/api/ai/pair'&&request.method==='POST'){admin(user);return json(await aiConnection.pair(user.tenant));}
  if(path==='/api/ai/settings'&&request.method==='POST'){admin(user);return json(await aiConnection.save(user.tenant,input));}
  if(path==='/api/ai/disconnect'&&request.method==='POST'){admin(user);return json(await aiConnection.disconnect(user.tenant));}
  const evaluationSetting=path.match(/^\/api\/accounts\/([^/]+)\/evaluation$/);
  if(evaluationSetting&&request.method==='POST'){
    admin(user);const account=await getAccount(user,evaluationSetting[1]);
    if(account.deleted_at)fail('Canal excluído.',410);if(typeof input.enabled!=='boolean')fail('Estado da avaliação inválido.');
    await run('update accounts set evaluation_enabled=$1 where id=$2 and tenant=$3',[input.enabled,account.id,user.tenant]);
    if(!input.enabled)await run("update attendance_evaluations set state='cancelled',error='Avaliação desativada no canal.',lease=null,updated=$1 where tenant=$2 and account=$3 and state in ('pending','waiting','processing')",[now(),user.tenant,account.id]);
    await audit(user.tenant,`Avaliação por IA de ${account.name} ${input.enabled?'ativada':'desativada'} por ${user.name}.`);return json({ok:true});
  }
  const evaluationRetry=path.match(/^\/api\/evaluations\/([0-9a-f-]{36})\/retry$/i);
  if(evaluationRetry&&request.method==='POST'){
    if(!managesAttendance(user))fail('Apenas administradores e recepcionistas podem solicitar nova análise.',403);
    const evaluation=await one('select * from attendance_evaluations where id=$1 and tenant=$2',[evaluationRetry[1],user.tenant]);
    if(!evaluation)fail('Avaliação não encontrada.',404);const c=await getConversation(user,evaluation.conversation),account=await getAccount(user,c.account);
    if(!account.evaluation_enabled||account.enabled===false||account.deleted_at)fail('Ative o canal e a avaliação antes de tentar novamente.');
    const result=await run("update attendance_evaluations set state='pending',attempts=0,error='',next_attempt=$1,updated=$1 where id=$2 and tenant=$3 and state in ('failed','waiting')",[now(),evaluation.id,user.tenant]);
    if(!result.rowCount)fail('A avaliação não está disponível para nova tentativa.',409);return json({ok:true});
  }
  if(path==='/api/outreach/search'&&request.method==='GET')return json(await outreach.search(user,url.searchParams));
  const outreachContact=path.match(/^\/api\/outreach\/contact\/([a-f0-9-]{36})$/i);
  if(outreachContact&&request.method==='GET')return json(await outreach.preview(user,outreachContact[1]));
  if(path==='/api/outreach/send'&&request.method==='POST'){
    await outreach.enqueue(user,input);await drainJobs(user.tenant);return json(await outreach.result(user,input.id));
  }
  const deleteChannelPath=path.match(/^\/api\/accounts\/([^/]+)\/delete$/);
  if(deleteChannelPath&&request.method==='POST')return json(await channelRemoval.remove(user,deleteChannelPath[1],input));
  const channelAction=path.match(/^\/api\/accounts\/([^/]+)\//);
  if(channelAction&&(await getAccount(user,channelAction[1])).deleted_at)fail('Este canal foi excluído. O histórico permanece disponível para consulta.',410);
  if(path==='/api/active-messages'&&request.method==='POST'){if(['preview-send','send'].includes(input.action)){const job=await activeMessages.record(user,input.id);if(job.kind==='subscription')fail('Assinaturas são enviadas pela rotina diária das 8h. Consulte a configuração.',409);return json(await appointmentNotifications.manual(user,input,job));}return json(await activeMessages.route(user,input));}
  if(path==='/api/cashbarber/daily-actions'&&request.method==='POST')return json(await dailyActions.settings(user,input));
  if(path==='/api/mercado-pago/settings'&&request.method==='POST')return json(await mercadoPagoSettings(user,input));
  if(path==='/api/cashbarber/notifications'&&request.method==='POST')return json(await appointmentNotifications.settings(user,input));
  if(path==='/api/cashbarber/notification-connection'&&request.method==='POST')return json(await appointmentNotifications.connection(user,input));
  if(path.startsWith('/api/cashbarber/')&&request.method==='POST')return json(await cashbarber.route(user,path,input));
  const operationPath=path.match(/^\/api\/messages\/([a-f0-9-]{36})\/(actions|forward-targets|edits|edit|forward)$/i);
  if(operationPath){
    const [,mid,action]=operationPath;
    if(request.method==='GET'&&action==='actions')return json(await messageOperations.context(user,mid));
    if(request.method==='GET'&&action==='forward-targets')return json(await messageOperations.targets(user,mid,url.searchParams));
    if(request.method==='GET'&&action==='edits')return json(await messageOperations.history(user,mid));
    if(request.method==='POST'&&['edit','forward'].includes(action))return json(await messageOperations.perform(user,mid,action,input));
    fail('Método inválido.',405);
  }
  const revokePath=path.match(/^\/api\/messages\/([0-9a-f-]{36})\/delete$/i);
  if(revokePath&&request.method==='POST'){
    const message=await one('select * from messages where id=$1',[revokePath[1]]);if(!message)fail('Mensagem não encontrada.',404);
    const conversation=await getConversation(user,message.conversation),account=await getAccount(user,conversation.account);
    message.deletion=(await whatsappContent.deletions(conversation)).find(d=>d.target_external===message.external);
    if(!canDeleteWhatsAppMessage({user,conversation,account,message:{...message,deletion:null},qr:usesQr(account)}))fail('Você não tem permissão para excluir esta mensagem enviada pelo WhatsApp.',403);
    if(message.deletion)return json({ok:true,already_deleted:true});
    if(input.confirm!==true)fail('Confirme a exclusão no WhatsApp.');
    const result=await qrClient.revoke(account,{recipient:conversation.customer,external:message.external,idempotencyKey:'delete:'+message.id});
    if(!result.ok||!result.external)fail('O WhatsApp não confirmou a solicitação de exclusão.',502);
    await whatsappContent.captureDeletion(account,{customer:conversation.customer,external:result.external,timestamp:now(),deletion:{target:message.external}},{actor:user.id,source:'central'});
    await audit(user.tenant,`Exclusão no WhatsApp solicitada por ${user.name}. Mensagem ${message.id} preservada na central.`);
    return json({ok:true});
  }
  const reactionPath=path.match(/^\/api\/messages\/([0-9a-f-]{36})\/react$/i);
  if(reactionPath&&request.method==='POST'){
    const message=await one('select * from messages where id=$1',[reactionPath[1]]);if(!message)fail('Mensagem não encontrada.',404);
    const conversation=await getConversation(user,message.conversation),account=await getAccount(user,conversation.account);
    message.deletion=(await whatsappContent.deletions(conversation)).find(d=>d.target_external===message.external||account.id+':'+d.target_external===message.external);
    if(!canReactWhatsAppMessage({user,conversation,account,message,qr:usesQr(account)}))fail('Você não tem permissão para reagir a esta mensagem no WhatsApp.',403);
    if(!isWhatsAppReaction(input.emoji))fail('Selecione uma reação válida.');
    if(typeof input.requestId!=='string'||! /^[0-9a-f-]{36}$/i.test(input.requestId))fail('Identificador da reação inválido.');
    const target=message.external.startsWith(account.id+':')?message.external.slice(account.id.length+1):message.external;
    const result=await qrClient.react(account,{recipient:conversation.customer,external:target,fromMe:message.direction==='out',emoji:input.emoji,idempotencyKey:'reaction:'+input.requestId});
    if(!result.ok||!result.external||!Number.isSafeInteger(result.timestamp))fail('O WhatsApp não confirmou o envio da reação.',502);
    await whatsappContent.captureReaction(account,{customer:conversation.customer,external:result.external,timestamp:result.timestamp,fromMe:true,reaction:{target,emoji:input.emoji}});
    await audit(user.tenant,`Reação no WhatsApp ${input.emoji?'enviada':'removida'} por ${user.name}. Mensagem ${message.id}.`);
    return json({ok:true});
  }
  const mediaPath=path.match(/^\/api\/messages\/([0-9a-f-]{36})\/media$/i);
  const mediaDiagnosticPath=path.match(/^\/api\/conversations\/([^/]+)\/media-diagnostics$/);
  if(mediaDiagnosticPath&&request.method==='GET'){admin(user);const conversation=await getConversation(user,mediaDiagnosticPath[1]),account=await getAccount(user,conversation.account);return json(await inboundMediaDiagnostics({pool,conversation,account}));}
  if(mediaPath&&['GET','HEAD'].includes(request.method)){
    const message=await one('select * from messages where id=$1',[mediaPath[1]]);if(!message)fail('Anexo não encontrado.',404);
    const conversation=await getConversation(user,message.conversation,{archived:true}),account=await getAccount(user,conversation.account);
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
  const visualAlertsPath=path.match(/^\/api\/accounts\/([0-9a-f-]{36})\/visual-alerts$/i);
  if(visualAlertsPath&&request.method==='POST'){
    admin(user);const account=await getAccount(user,visualAlertsPath[1]);if(account.deleted_at)fail('Este canal foi excluído.',410);
    const legacy=input.queueMinutes===undefined&&input.assignedMinutes===undefined,queueMinutes=legacy?input.minutes:input.queueMinutes,assignedMinutes=legacy?input.minutes:input.assignedMinutes;
    for(const [label,value]of [['Fila',queueMinutes],['Atendimentos atribuídos',assignedMinutes]])if(!Number.isInteger(value)||value<1||value>1440)fail(label+': informe um prazo entre 1 e 1440 minutos.');
    await run('update accounts set visual_queue_minutes=$1,visual_assigned_minutes=$2,visual_alert_minutes=case when $3 then $1 else visual_alert_minutes end where id=$4 and tenant=$5',[queueMinutes,assignedMinutes,legacy,account.id,user.tenant]);
    await audit(user.tenant,'Prazo dos avisos visuais de '+account.name+' alterado por '+user.name+': fila '+queueMinutes+' min; atribuídos '+assignedMinutes+' min.');return json({ok:true});
  }
  const diagnosticPath=path.match(/^\/api\/accounts\/([^/]+)\/diagnostics$/);
  if(path==='/api/conversations/queue-close-preview'&&request.method==='POST')return json(await attendance.queueClosePreview(user,input));
  const interactionClose=path.match(/^\/api\/conversations\/([0-9a-f-]{36})\/close-interaction$/i);
  if(interactionClose&&request.method==='POST')return json(await attendance.closeInteraction(user,interactionClose[1],input));
  if(path==='/api/conversations/queue-close'&&request.method==='POST')return json(await attendance.closeQueue(user,input));
  const attendancePath=path.match(/^\/api\/conversations\/([^/]+)\/(claim|transfer)$/);
  if(attendancePath&&request.method==='POST'){const c=await getConversation(user,attendancePath[1]);return json(attendancePath[2]==='claim'?await attendance.claim(user,c.id):await attendance.transfer(user,c.id,input));}
  const attendanceTagsPath=path.match(/^\/api\/conversations\/([^/]+)\/tags$/);
  if(attendanceTagsPath&&request.method==='POST'){const c=await getConversation(user,attendanceTagsPath[1]);return json(await crm.setAttendanceTags(user,c.id,input));}
  if(path.startsWith('/api/contacts')&&['GET','POST'].includes(request.method))return json(await contacts.route(user,path,request.method==='POST'?input:undefined,url.searchParams));
  if(path==='/api/crm/state'&&request.method==='GET')return json(await crm.state(user));
  if(path.startsWith('/api/crm/')&&request.method==='POST')return json(await crm.route(user,path,input));
  const qrPath=path.match(/^\/api\/accounts\/([^/]+)\/qr(?:\/(connect|disconnect))?$/);
  if(qrPath){admin(user);const account=await getAccount(user,qrPath[1]);if(!usesQr(account)||account.mode!=='live')fail('Selecione um canal WhatsApp por QR Code ativo.');const action=qrPath[2];if(action==='connect'&&account.enabled===false)fail('Ative o canal antes de conectar o WhatsApp.',409);if((!action&&request.method!=='GET')||(action&&request.method!=='POST'))fail('Método inválido.',405);const result=await qrClient[action||'status'](account);if(action)await audit(user.tenant,`Conexão QR de ${account.name}: ${action==='connect'?'iniciada':'desconectada'} por ${user.name}.`);return json(result);}
  if(diagnosticPath&&request.method==='GET'){admin(user);const account=await getAccount(user,diagnosticPath[1]);if(usesQr(account))return json(await qrClient.status(account));const result=await inspectMetaAccount(account,open(account.secret));if(account.channel==='whatsapp'){const tenant=await one('select phone from tenants where id=$1',[user.tenant]);const window=await one('select seen from bridge_windows where account=$1 and phone=$2',[account.id,tenant.phone]);result.teamWindow=inspectWhatsAppWindow(window?.seen);}return json(result);}
  const activationPath=path.match(/^\/api\/accounts\/([^/]+)\/activation$/);
  if(activationPath&&request.method==='POST'){
    admin(user);const account=await getAccount(user,activationPath[1]);if(typeof input.enabled!=='boolean')fail('Estado do canal inválido.');
    if(account.enabled===input.enabled)return json({ok:true});
    await run('update accounts set enabled=$2,receive_after=case when $2 then $3 else receive_after end where id=$1',[account.id,input.enabled,Math.floor(now()/1000)*1000]);
    if(!input.enabled){
      await run("update messages set state='failed' where id in (select message from jobs where tenant=$1 and state='pending' and (account=$2 or alert_source=$2 or conversation in (select id from conversations where account=$2)))",[user.tenant,account.id]);
      await run("update jobs set state='cancelled',error='Canal desativado.' where tenant=$1 and state='pending' and (account=$2 or alert_source=$2 or conversation in (select id from conversations where account=$2))",[user.tenant,account.id]);
    }
    let warning='';if(usesQr(account)&&account.mode==='live')try{await qrClient[input.enabled?'resume':'pause'](account);}catch{warning='O estado do canal foi salvo. Confira a conexão do serviço WhatsApp.';}
    await audit(user.tenant,`Canal ${account.name} ${input.enabled?'ativado':'desativado'} por ${user.name}.`);return json({ok:true,warning});
  }
  const alertsPath=path.match(/^\/api\/accounts\/([^/]+)\/alerts$/);
  if(alertsPath&&request.method==='POST'){
    admin(user);const account=await getAccount(user,alertsPath[1]),settings=alertSettings(input,account);
    const bridge=input.bridge===undefined?account.bridge:String(input.bridge||'')||null;
    const sender=bridge?await getAccount(user,bridge):account.channel==='whatsapp'?account:null;
    if(bridge&&sender.channel!=='whatsapp')fail('Selecione uma conta WhatsApp para os alertas.');
    if(settings.enabled&&(!sender||sender.enabled===false||sender.mode!=='live'))fail('Selecione uma conta WhatsApp em API real para enviar os alertas.');
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
    if(account.alerts_enabled&&(!sender||sender.enabled===false||sender.mode!=='live'))fail('Mantenha uma conta WhatsApp ativa para os alertas.');
    await run('update accounts set service_hours=$2,forwarding_phone=$3,forwarding_period=$4,forwarding_enabled=$5,bridge=$6 where id=$1',[account.id,JSON.stringify(settings.hours),settings.phone,settings.period,input.forwardingEnabled,bridge]);
    await run("update jobs set state='cancelled',error='Configuração de encaminhamento alterada.' where tenant=$1 and kind='forward' and state='pending' and conversation in (select id from conversations where account=$2)",[user.tenant,account.id]);
    await audit(user.tenant,`Horários e encaminhamento de ${account.name} atualizados por ${user.name}.`);
    return json({ok:true});
  }
  const contactPath=path.match(/^\/api\/conversations\/([^/]+)\/contact$/);
  if(contactPath&&request.method==='POST'){if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);const c=await getConversation(user,contactPath[1]);if(!worksAttendance(user,c))fail('Assuma o atendimento antes de identificar o cliente.',403);if(input.action==='refresh'){const a=await getAccount(user,c.account),identity=await customerProfile(a,open(a.secret),c.customer);if(!identity.name&&!identity.username)fail('A Meta não disponibilizou o nome deste cliente. Você pode identificá-lo manualmente.',422);await run("update conversations set name=case when name_manual then name else $1 end,username=$2,profile_checked=$3 where id=$4",[identity.name||identity.username,identity.username||'',now(),c.id]);}else{await run('update conversations set name=$1,name_manual=true where id=$2',[required(input.name,'Nome do cliente'),c.id]);}return json({ok:true});}
  if(path==='/api/logout'&&request.method==='POST'){await run('delete from sessions where id=$1',[sh]);return json({ok:true},200,{'set-cookie':'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});}
  if(path==='/api/state'&&request.method==='GET'){const snapshotTime=now();let accounts=(await rows('select * from accounts where tenant=$1',[user.tenant])).filter(a=>permitted(user,a)),allowed=new Set(accounts.map(a=>a.id));const since=Number(url.searchParams.get('since')),partial=Number.isSafeInteger(since)&&since>0&&since<=snapshotTime;
    const visible=partial?(await rows('select id,tenant,account,assigned_to,status from conversations where tenant=$1',[user.tenant])).filter(c=>allowed.has(c.account)&&seesAttendance(user,c)).map(c=>c.id):null;
    const conversations=(await rows(partial?`select c.* from conversations c where c.tenant=$1 and (c.status='open' or c.updated>=$2
      or exists(select 1 from messages v where v.conversation=c.id and v.first_viewed_at>=$2)
      or exists(select 1 from attendance_evaluations e where e.tenant=c.tenant and e.conversation=c.id and e.updated>=$2)
      or exists(select 1 from whatsapp_deletions d where d.tenant=c.tenant and d.account=c.account and d.customer=c.customer and d.deleted_at>=$2)
      or exists(select 1 from whatsapp_reactions r where r.tenant=c.tenant and r.account=c.account and r.customer=c.customer and r.created>=$2)) order by c.updated desc`:'select * from conversations where tenant=$1 order by updated desc',partial?[user.tenant,since]:[user.tenant])).filter(c=>allowed.has(c.account)&&seesAttendance(user,c));await hydrateInbox({pool,user,accounts,conversations,usesQr});return json({server_time:snapshotTime,clock_time:now(),partial,...(partial?{visible_conversation_ids:visible}:{}),user:{id:user.id,name:user.name,email:user.email,role:user.role,appearance:user.appearance||'original'},tenant:await one('select * from tenants where id=$1',[user.tenant]),accounts:accounts.map(a=>user.role==='admin'?safeAccount(a):{id:a.id,name:a.name,channel:a.channel,mode:a.mode,bridge:a.bridge,enabled:a.enabled,deleted_at:a.deleted_at,visual_alert_minutes:a.visual_alert_minutes,visual_queue_minutes:a.visual_queue_minutes,visual_assigned_minutes:a.visual_assigned_minutes,forwarding_enabled:a.forwarding_enabled,service_hours:a.service_hours,forwarding_phone:a.forwarding_phone,forwarding_period:a.forwarding_period}),conversations,users:user.role==='admin'?await rows('select id,name,email,role,accounts from users where tenant=$1',[user.tenant]):[],audit:user.role==='admin'?await rows('select * from audit where tenant=$1 order by created desc limit 50',[user.tenant]):[],jobs:user.role==='admin'?await rows('select j.id,j.kind,j.state,j.error,j.created,j.recipient,a.name as source_name from jobs j left join accounts a on a.id=j.alert_source and a.tenant=j.tenant where j.tenant=$1 order by j.created desc limit 50',[user.tenant]):[]});}
  if(path==='/api/accounts'&&request.method==='POST'){
    admin(user);
    const old=input.id?await getAccount(user,input.id):null,channel=old?.channel||input.channel;
    if(old?.deleted_at)fail('Este canal foi excluído. Adicione um novo canal para conectar novamente.',410);
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
    if(bridge){const b=await getAccount(user,bridge);if(b.deleted_at||b.channel!=='whatsapp')fail('Selecione uma conta WhatsApp disponível para a ponte.');if(bridge===aid)fail('Selecione outro canal para encaminhar mensagens.');}
    const forwardingEnabled=typeof input.forwardingEnabled==='boolean'?input.forwardingEnabled:old?.forwarding_enabled??false;
    if(forwardingEnabled&&!bridge&&channel!=='whatsapp')fail('Selecione uma conta WhatsApp para encaminhar.');
    if(forwardingEnabled&&mode==='live'){if(!bridge&&!old?.forwarding_phone)fail('Configure o telefone de destino em Horários e encaminhamento.');const tenant=await one('select phone from tenants where id=$1',[user.tenant]);await validateForwardingTarget(user,{...old,id:aid,tenant:user.tenant,channel,mode,secret:seal(secrets)},bridge,old?.forwarding_phone||tenant.phone);}
    if(alerts.enabled){const sender=bridge?await getAccount(user,bridge):channel==='whatsapp'?{channel,mode}:null;if(!sender||sender.enabled===false||sender.channel!=='whatsapp'||sender.mode!=='live')fail('Selecione uma conta WhatsApp ativa para enviar os alertas.');}
    if(channel==='instagram'&&mode==='live')await configureInstagramWebhook(external,secrets);
    await run('insert into accounts(id,tenant,name,channel,external,secret,mode,bridge,forwarding_enabled,alerts_enabled,queue_alert_minutes,assigned_alert_minutes,alerts_phones) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(id) do update set name=excluded.name,external=excluded.external,secret=excluded.secret,mode=excluded.mode,bridge=excluded.bridge,forwarding_enabled=excluded.forwarding_enabled,alerts_enabled=excluded.alerts_enabled,queue_alert_minutes=excluded.queue_alert_minutes,assigned_alert_minutes=excluded.assigned_alert_minutes,alerts_phones=excluded.alerts_phones',[aid,user.tenant,required(input.name,'Nome'),channel,external,seal(secrets),mode,bridge,forwardingEnabled,alerts.enabled,alerts.queue,alerts.assigned,alerts.phones]);
    if(channel==='whatsapp'&&mode==='live'&&transport==='meta')await configureWhatsAppWebhook(aid,secrets);
    await audit(user.tenant,`Conta ${input.name} configurada por ${user.name}.`);
    return json({ok:true,id:aid,transport});
  }
  if(path==='/api/users'&&request.method==='POST'){admin(user);const old=input.id?await one('select * from users where id=$1 and tenant=$2',[input.id,user.tenant]):null;if(input.id&&!old)fail('Usuário não encontrado.',404);if(!['admin','receptionist','agent','viewer'].includes(input.role))fail('Perfil inválido.');if(old?.id===user.id&&input.role!=='admin')fail('Você não pode remover seu próprio acesso administrativo.');if(!Array.isArray(input.accounts))fail('Selecione as contas permitidas.');for(const aid of input.accounts)await getAccount(user,aid);const mail=email(input.email),dupe=await one('select id from users where email=$1 and id<>$2',[mail,old?.id||id()]);if(dupe)fail('E-mail já utilizado.');const h=input.password?hash(password(input.password)):old?.hash;if(!h)fail('Defina uma senha com pelo menos 8 caracteres.');await run('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set name=excluded.name,email=excluded.email,hash=excluded.hash,role=excluded.role,accounts=excluded.accounts',[old?.id||id(),user.tenant,required(input.name,'Nome'),mail,h,input.role,input.accounts]);if(old)await run('delete from sessions where "user"=$1 and id<>$2',[old.id,sh]);await audit(user.tenant,`Permissões de ${input.name} atualizadas por ${user.name}.`);return json({ok:true});}
  if(path==='/api/tenant'&&request.method==='POST'){admin(user);await run('update tenants set name=$1,phone=$2 where id=$3',[required(input.name,'Empresa'),phone(input.phone),user.tenant]);return json({ok:true});}
  if(path==='/api/tenants'&&request.method==='POST'){admin(user);const mail=email(input.email);if(await one('select id from users where email=$1',[mail]))fail('Use um e-mail exclusivo para a nova empresa.');const t=id();await run('insert into tenants(id,name,phone) values($1,$2,$3)',[t,required(input.name,'Empresa'),phone(input.phone)]);await run('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[id(),t,required(input.adminName,'Administrador'),mail,hash(password(input.password)),'admin',[]]);return json({ok:true},201);}
  let m=path.match(/^\/api\/conversations\/([^/]+)\/status$/);if(m&&request.method==='POST'){if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);const c=await getConversation(user,m[1]);if(!['open','resolved'].includes(input.status))fail('Status inválido.');return json(await attendance.status(user,c.id,input.status,input));}
  m=path.match(/^\/api\/conversations\/([^/]+)\/reply$/);if(m&&request.method==='POST'){
    if(user.role==='viewer')fail('Seu perfil permite apenas visualizar.',403);
    const c=await getConversation(user,m[1]),a=await getAccount(user,c.account),body=input.attachmentId?String(input.body||'').trim():required(input.body,'Mensagem',2000),mid=id();
    if(a.enabled===false)fail('Canal desativado. Ative o canal para enviar mensagens.',409);
    if(a.mode==='live'&&c.customer.startsWith('demo-'))fail('Conversa demonstrativa não pode enviar mensagens reais.');
    const signer=await replySigner({pool,permitted,user,account:a,signatureUser:input.signature_user});
    let signed;try{signed=body?signedReply(signer.name,body):'';}catch(error){fail(error.message);}
    if(!c.assigned_to)fail('Clique em Assumir atendimento antes de responder.',403);
    else if(!canReplyAttendance(user,c))fail('Atendimento indisponível para responder. Reabra o atendimento se estiver finalizado.',403);
    const replyTo=await resolveQuotedReply({pool,conversation:c,account:a,messageId:input.reply_to});
    await crm.assignOnReply(c,user);
    if(input.attachmentId){
      if(a.mode==='live'&&needsWindow(a)&&now()-Number(c.last_inbound)>86400000)fail('A janela de resposta de 24 horas está encerrada.');
      const attachmentMessage=await replyAttachments.enqueue(user,c,a,input,signer,replyTo);if(a.mode==='live')await drainJobs(user.tenant,c.id);
      const result=await one('select state from messages where id=$1',[attachmentMessage]);return json({ok:true,state:result?.state});
    }
    if(a.mode==='demo'){await run("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name,signature_user,signature_name,media) values($1,$2,'out',$3,$4,'simulated',$5,$6,$7,$8,$9)",[mid,c.id,body,now(),user.id,user.name,signer.id,signer.name,replyTo?JSON.stringify({replyTo}):'{}']);await run('update conversations set updated=$1 where id=$2',[now(),c.id]);return json({ok:true});}
    if(needsWindow(a)&&now()-Number(c.last_inbound)>86400000)fail('A janela de resposta de 24 horas está encerrada.');
    await run("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name,signature_user,signature_name,media) values($1,$2,'out',$3,$4,'queued',$5,$6,$7,$8,$9)",[mid,c.id,body,now(),user.id,user.name,signer.id,signer.name,replyTo?JSON.stringify({replyTo}):'{}']);
    await queue(a,c,mid,'reply',c.customer,signed);await drainJobs(user.tenant,c.id);
    const sent=await one('select state,error from jobs where message=$1 order by created desc limit 1',[mid]);
    if(sent?.state==='failed')fail(sent.error||'Falha no envio.',502);
    const updated=now();await run('update conversations set updated=$1 where id=$2',[updated,c.id]);
    const message=await one('select * from messages where id=$1 and conversation=$2',[mid,c.id]);
    const policy={user,conversation:c,account:a,message,qr:usesQr(a)};message.can_edit=canEditMessage(policy,now());message.can_forward=canForwardMessage(policy);
    return json({ok:true,state:message.state,message,updated});
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
  if(account.enabled===false)return json({received:true,ignored:true});
  const payload=qrInboundPayload(account,event),eid=digest(account.id+event.id);
  const existing=await one('select state from events where id=$1',[eid]);if(existing?.state==='done')return json({received:true});
  await run('insert into events(id,tenant,payload,state,error,created) values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing',[eid,account.tenant,payload,'received','',now()]);
  try{await processInbound(account,payload);await run("update events set state='done',error='' where id=$1",[eid]);}
  catch(error){await run("update events set state='failed',error='Falha no processamento QR; nova tentativa pendente.' where id=$1",[eid]);throw error;}
  await drainJobs(account.tenant);return json({received:true});
}
export default {async fetch(request){try{const url=new URL(request.url),path=url.pathname;if(/^\/webhooks\/whatsapp-qr\/[a-f0-9-]{36}$/i.test(path))return await qrWebhook(request,path);if(path.startsWith('/webhooks/meta/'))return await webhook(request,url,path);if(path.startsWith('/api/'))return await api(request,url,path);return json({error:'Não encontrado.'},404);}catch(error){console.error(error);if(error.code==='42P01')return json({error:'Banco de dados ainda não inicializado.'},503);if(error.code==='23505')return json({error:'Registro já existente.'},409);return json({error:error.status?error.message:'Erro interno da central.'},error.status||500);}}};
