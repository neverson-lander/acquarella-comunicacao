import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {metaAttachments,incomingBody,inboundMediaUrl,metaInboundResponse} from '../lib/inbound-media.mjs';
import {recoverInboundMedia} from '../lib/recover-inbound-media.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {inboundWhatsApp} from '../lib/sac.mjs';
import {whatsappMediaResponse} from '../lib/whatsapp-media.mjs';
import {messageContent} from '../public/message-content.js';
import {inboundMediaDiagnostics} from '../lib/inbound-media-diagnostics.mjs';
const media=['image','audio','video','file'].map(type=>({type,payload:{url:'https://scontent.cdninstagram.com/'+type},name:type==='file'?'teste.pdf':type}));
test('administrator diagnostics report missing payloads without disclosing message bodies or signed media links',async()=>{
 let call=0;const pool={query:async()=>({rows:++call===1?[{id:'m',external:'a:mid',kind:'text',media:{}}]:[{payload:{entry:[{messaging:[{message:{mid:'mid',text:'PRIVATE CUSTOMER TEXT',is_unsupported:true,attachments:[{type:'unknown',payload:{url:'https://scontent.fbcdn.net/file?secret=PRIVATE'}}]}}]}]}}]})};
 const result=await inboundMediaDiagnostics({pool,conversation:{id:'c',tenant:'t'},account:{id:'a',channel:'instagram'}});assert.equal(result.messages[0].unsupported,true);assert.equal(result.messages[0].attachments[0].hasUrl,true);assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('https://'));
});
test('Instagram and Messenger retain all supported attachments; reject arbitrary URLs and render safe local previews',()=>{
 const parsed=metaAttachments({text:'Legenda 😊',attachments:media});assert.equal(parsed.media.items.length,4);assert.equal(parsed.media.caption,'Legenda 😊');
 for(const url of ['http://fbcdn.net/x','https://fbcdn.net.attacker.test/x','https://user:secret@fbcdn.net/x','https://fbcdn.net:8080/x','https://127.0.0.1/x'])assert.equal(inboundMediaUrl(url),'');
 assert.equal(metaAttachments({attachments:[{type:'image',payload:{url:'https://evil.test/a'}}]}),null);
 assert.equal(metaAttachments({attachments:[{type:'ig_reel',payload:{url:'https://lookaside.fbsbx.com/video'}}]}).kind,'shared');
 assert.equal(incomingBody({text:'😊 ❤️'}),'😊 ❤️');assert.match(incomingBody({is_unsupported:true}),/Conteúdo não disponibilizado pela Meta/);
 const html=messageContent({id:'msg',...parsed,body:'caption'},s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'));
 assert.ok(html.includes('<video'));assert.ok(html.includes('<audio'));assert.ok(html.includes('<img'));assert.ok(html.includes('attachment=3&preview=1'));assert.ok(html.includes('Legenda 😊'));assert.ok(!html.includes('src="https://'));
});
test('inbound proxy streams ranges, refreshes expiring links and never forwards tokens to CDN or redirected hosts',async()=>{
 const account={id:'account',channel:'instagram',mode:'live'},secrets={token:'SECRET'},message={external:'account:mid',...metaAttachments({attachments:[media[0]]})};const calls=[];let saved=false;
 const fetcher=async(url,options)=>{calls.push({url,options});if(url.includes('graph.instagram.com'))return new Response(JSON.stringify({attachments:{data:[{image_data:{url:'https://scontent.fbcdn.net/fresh'}}]}}));if(url.endsWith('/image'))return new Response('expired',{status:403});return new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-type':'image/png','content-range':'bytes 0-2/3','accept-ranges':'bytes'}});};
 const result=await metaInboundResponse({account,secrets,message,range:'bytes=0-2',fetcher,save:async()=>saved=true});assert.equal(result.status,206);assert.deepEqual([...new Uint8Array(await result.arrayBuffer())],[1,2,3]);assert.equal(saved,true);assert.equal(calls[1].options.headers.Authorization,'Bearer SECRET');assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[2].options.headers.Authorization,undefined);
 await assert.rejects(metaInboundResponse({account,secrets,message,fetcher:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})}),/não permitido/);
 await assert.rejects(metaInboundResponse({account,secrets,message,fetcher:async()=>new Response('html',{headers:{'content-type':'text/html'}})}),/incompatível/);
 const pdfMessage={...message,...metaAttachments({attachments:[media[3]]})};const pdf=await metaInboundResponse({account,secrets,message:pdfMessage,preview:true,fetcher:async()=>new Response('%PDF',{headers:{'content-type':'application/pdf'}})});assert.match(pdf.headers.get('content-disposition'),/^inline/);assert.equal(await pdf.text(),'%PDF');
 const sharedMessage={...message,...metaAttachments({attachments:[{type:'ig_reel',payload:{url:'https://lookaside.fbsbx.com/reel'}}]})};const video=await metaInboundResponse({account,secrets,message:sharedMessage,fetcher:async()=>new Response('video',{headers:{'content-type':'video/mp4'}})});assert.equal(video.headers.get('x-attachment-kind'),'video');assert.match(video.headers.get('content-disposition'),/\.mp4/);await video.body.cancel();
});
test('WhatsApp receives videos and named documents, proxies them and opens PDF previews',async()=>{
 for(const [kind,mime] of [['video','video/mp4'],['document','application/pdf']]){
  const message=inboundWhatsApp({messages:[{id:'m',from:'123',type:kind,[kind]:{id:'456',mime_type:mime,filename:'teste.pdf'}}]})[0];assert.equal(message.media.id,'456');assert.equal(message.media.name,'teste.pdf');
  const response=await whatsappMediaResponse({account:{channel:'whatsapp',mode:'live',external:'123'},secrets:{token:'PRIVATE'},message,preview:true,fetcher:async url=>url.includes('graph.facebook.com')?new Response(JSON.stringify({url:'https://lookaside.fbsbx.com/media',mime_type:mime,file_size:3})):new Response('abc')});assert.equal(await response.text(),'abc');assert.equal(response.headers.get('content-type'),mime);assert.match(response.headers.get('content-disposition'),/^inline/);
 }
});
test('webhooks save multiple incoming attachments once and recover historical media without new conversations or deliveries',async()=>{
 const db=new PGlite(),tenant=randomUUID(),aid=randomUUID(),stamp=Date.now();
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},one=async(sql,args)=>(await query(sql,args)).rows[0];
 try{
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await query("insert into tenants(id,name,phone) values($1,'Test','5534988748139')",[tenant]);await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'Instagram','instagram','123','unused','live')",[aid,tenant]);
  const account=await one('select * from accounts where id=$1',[aid]),handler=createInboundHandler({one,run:query,id:randomUUID,now:()=>stamp,open:()=>({instagramIds:['456']}),profile:async()=>({name:'Pessoa'}),send:async()=>{},queue:async()=>{},audit:async()=>{}});
  const payload={entry:[{id:'456',messaging:[{sender:{id:'customer'},timestamp:stamp,message:{mid:'incoming',text:'Legenda',attachments:media}}]}]};
  await handler(account,payload);await handler(account,payload);const messages=(await query('select * from messages')).rows;assert.equal(messages.length,1);assert.equal(messages[0].media.items.length,4);assert.equal(messages[0].body,'Legenda');
  await query("update messages set media='{}',kind='text',body='[Anexo recebido - consulte o canal de origem]'");await query("insert into events(id,tenant,payload,state,created) values('old',$1,$2,'done',$3)",[tenant,JSON.stringify(payload),stamp]);
  assert.equal(await recoverInboundMedia({query},()=>({instagramIds:['456']})),1);assert.equal(await recoverInboundMedia({query},()=>({instagramIds:['456']})),0);
  assert.equal((await one('select media from messages')).media.items.length,4);assert.equal((await one('select count(*) as n from conversations')).n,1);
  await query("update conversations set status='resolved'");
  await handler(account,{entry:[{id:'456',messaging:[{sender:{id:'customer'},message:{mid:'incoming',is_deleted:true}},{sender:{id:'new-customer'},message:{mid:'unknown',is_deleted:true}}]}]});
  assert.equal((await one('select kind from messages')).kind,'deleted');assert.match((await one('select body from messages')).body,/Mensagem excluída/);
  assert.equal((await one('select status from conversations')).status,'resolved');assert.equal((await one('select count(*) as n from conversations')).n,1);assert.equal((await one('select count(*) as n from messages')).n,1);
 }finally{await db.close();}
});
