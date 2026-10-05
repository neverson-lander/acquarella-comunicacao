import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';
import {inboundWhatsApp} from '../lib/sac.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {createWhatsAppContent} from '../lib/whatsapp-content.mjs';
import {validMediaUrl,whatsappMediaResponse} from '../lib/whatsapp-media.mjs';
import {messageContent} from '../public/message-content.js';
const stamp=1791160000000;
const value=messages=>({metadata:{phone_number_id:'123'},messages:messages.map((m,i)=>({id:'event-'+i,from:'5534999990000',timestamp:String(stamp/1000),...m}))});
const payload=messages=>({object:'whatsapp_business_account',entry:[{changes:[{value:value(messages)}]}]});
const types=[{type:'image',image:{id:'456',mime_type:'image/png',caption:'Documento'}},{type:'audio',audio:{id:'789',mime_type:'audio/ogg',voice:true}},{type:'sticker',sticker:{id:'999',mime_type:'image/webp'}}];
test('WhatsApp parser retains media IDs, voice notes and emoji reactions including removal',()=>{
  const parsed=inboundWhatsApp(value([...types,{type:'reaction',reaction:{message_id:'original',emoji:'❤️'}},{type:'reaction',reaction:{message_id:'original'}}]));
  assert.equal(parsed[0].media.id,'456');assert.equal(parsed[0].media.caption,'Documento');assert.equal(parsed[1].media.voice,true);assert.equal(parsed[2].kind,'sticker');
  assert.deepEqual(parsed[3].reaction,{target:'original',emoji:'❤️'});assert.deepEqual(parsed[4].reaction,{target:'original',emoji:''});
});
async function fixture(){
 const db=new PGlite();
 for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())if(!file.includes('whatsapp_content'))await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 const pool={query:async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};}},tenant=randomUUID(),aid=randomUUID(),cid=randomUUID();
 await pool.query('insert into tenants(id,name,phone) values($1,$2,$3)',[tenant,'Company','5534988748139']);
 await pool.query("insert into accounts(id,tenant,name,channel,external,mode,secret) values($1,$2,'WhatsApp','whatsapp','123','live','unused')",[aid,tenant]);
 await pool.query("insert into conversations(id,tenant,account,customer,name,status,last_inbound,updated) values($1,$2,$3,'5534999990000','Maria','resolved',$4,$4)",[cid,tenant,aid,stamp-1000]);
 return {db,pool,tenant,aid,cid,account:(await pool.query('select * from accounts where id=$1',[aid])).rows[0],migrate:async()=>db.exec(await readFile(new URL('../supabase/migrations/202610040011_whatsapp_content.sql',import.meta.url),'utf8'))};
}
test('migration recovers old image/audio metadata and reactions from retained events',async()=>{
 const f=await fixture();try{
  const event=payload([...types,{type:'reaction',reaction:{message_id:'outbound',emoji:'👍'}}]);
  await f.pool.query("insert into events(id,tenant,payload,state,created) values('historical',$1,$2,'done',$3)",[f.tenant,JSON.stringify(event),stamp]);
  for(let i=0;i<4;i++)await f.pool.query("insert into messages(id,conversation,direction,body,created,state,external) values($1,$2,'in','[Anexo]',$3,'received',$4)",[randomUUID(),f.cid,stamp,f.aid+':event-'+i]);
  await f.migrate();
  const messages=(await f.pool.query('select kind,media from messages order by external')).rows;
  assert.equal(messages[0].kind,'image');assert.equal(messages[0].media.id,'456');assert.equal(messages[1].kind,'audio');assert.equal(messages[3].kind,'reaction');
  assert.equal((await createWhatsAppContent({pool:f.pool}).reactions({tenant:f.tenant,account:f.aid,customer:'5534999990000'}))[0].emoji,'👍');
 }finally{await f.db.close();}
});
test('receiving media saves attachments; reactions deduplicate, replace and remove without reopening the case',async()=>{
 const f=await fixture();try{
  await f.migrate();const content=createWhatsAppContent({pool:f.pool}),forwarded=[];
  const handler=createInboundHandler({one:async(s,v)=>(await f.pool.query(s,v)).rows[0],run:f.pool.query,id:randomUUID,now:()=>stamp,open:()=>({}),profile:async()=>({}),send:async()=>{},queue:async(...args)=>forwarded.push(args),audit:async()=>{},captureReaction:content.captureReaction});
  await handler(f.account,payload(types));
  const media=(await f.pool.query('select kind,media from messages')).rows;assert.equal(media.length,3);assert.ok(media.some(m=>m.media.id==='789'&&m.kind==='audio'));
  await f.pool.query("update conversations set status='resolved' where id=$1",[f.cid]);
  const original=(await f.pool.query('select last_inbound from conversations where id=$1',[f.cid])).rows[0].last_inbound;
  const reaction=payload([{id:'r1',type:'reaction',reaction:{message_id:'target-out',emoji:'❤️'}}]);
  await handler(f.account,reaction);await handler(f.account,reaction);
  assert.equal((await f.pool.query('select count(*) as n from whatsapp_reactions')).rows[0].n,1);
  assert.equal((await f.pool.query('select count(*) as n from messages')).rows[0].n,3);
  const c=(await f.pool.query('select * from conversations where id=$1',[f.cid])).rows[0];assert.equal(c.status,'resolved');assert.equal(c.last_inbound,original);
  assert.equal((await content.reactions(c))[0].emoji,'❤️');
  await handler(f.account,payload([{id:'r2',type:'reaction',reaction:{message_id:'target-out',emoji:'👍'}}]));assert.equal((await content.reactions(c))[0].emoji,'👍');
  await handler(f.account,payload([{id:'r3',type:'reaction',reaction:{message_id:'target-out'}}]));assert.deepEqual(await content.reactions(c),[]);
  await handler(f.account,payload([{id:'older',timestamp:String(stamp/1000-5),type:'reaction',reaction:{message_id:'target-out',emoji:'😮'}}]));assert.deepEqual(await content.reactions(c),[]);
  assert.deepEqual(await content.reactions({...c,customer:'another'}),[]);assert.equal(forwarded.length,0);
 }finally{await f.db.close();}
});
test('media proxy refreshes expiring URLs, streams bytes/ranges and keeps tokens on the server',async()=>{
 const calls=[],request={account:{channel:'whatsapp',mode:'live',external:'123'},secrets:{token:'PRIVATE',version:'v26.0'},message:{kind:'audio',media:{id:'456'}}};
 const fetcher=async(url,options)=>{calls.push({url,options});return url.includes('graph.facebook.com')?new Response(JSON.stringify({url:'https://lookaside.fbsbx.com/media?id=456',mime_type:'audio/ogg',file_size:3})):new Response(new Uint8Array([1,2,3]),{status:206,headers:{'content-range':'bytes 0-2/3','accept-ranges':'bytes'}});};
 const response=await whatsappMediaResponse({...request,range:'bytes=0-2',fetcher});assert.equal(response.status,206);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);
 assert.equal(response.headers.get('content-type'),'audio/ogg');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(calls[1].options.headers.Range,'bytes=0-2');
 assert.ok(calls[0].url.includes('phone_number_id=123'));assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer PRIVATE'));assert.ok(!JSON.stringify([...response.headers]).includes('PRIVATE'));
 await assert.rejects(whatsappMediaResponse({...request,range:'bytes=0-2,3-4',fetcher}),e=>e.status===416);
 for(const url of ['http://lookaside.fbsbx.com/a','https://attacker.com/a','https://fbsbx.com.attacker.com/a','https://user:pass@fbsbx.com/a','https://fbsbx.com:8080/a'])assert.equal(validMediaUrl(url),'');
 await assert.rejects(whatsappMediaResponse({...request,fetcher:async()=>new Response(JSON.stringify({url:'https://attacker.com',mime_type:'audio/ogg'}))}),/não permitido/);
 await assert.rejects(whatsappMediaResponse({...request,fetcher:async()=>new Response(JSON.stringify({url:'https://lookaside.fbsbx.com/a',mime_type:'text/html'}))}),/não permitido/);
 await assert.rejects(whatsappMediaResponse({...request,fetcher:async()=>new Response('not found',{status:404})}),e=>e.status===404);
});
test('media route enforces login, channel/tenant and conversation ownership before contacting Meta',async()=>{
 const f=await fixture();try{
  await f.migrate();globalThis.__acquarellaPool=f.pool;
  const key=randomBytes(32);process.env.APP_ENCRYPTION_KEY=key.toString('base64');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update('{"token":"PRIVATE"}'),cipher.final()]);
  await f.pool.query('update accounts set secret=$1',[Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64')]);
  const uid=randomUUID(),mid=randomUUID();await f.pool.query("insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,'Viewer','viewer@test.invalid','unused','viewer','[]')",[uid,f.tenant]);
  await f.pool.query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update('viewer-session').digest('hex'),uid,Date.now()+60000]);
  await f.pool.query("insert into messages(id,conversation,direction,body,created,state,kind,media) values($1,$2,'in','Image',$3,'received','image',$4)",[mid,f.cid,stamp,JSON.stringify({id:'456'})]);
  const {default:app}=await import('../api/index.mjs');const url=`https://example.test/api/messages/${mid}/media`;
  assert.equal((await app.fetch(new Request(url))).status,401);
  assert.equal((await app.fetch(new Request(url,{headers:{cookie:'session=viewer-session'}}))).status,403);
  await f.pool.query('update users set accounts=$2 where id=$1',[uid,JSON.stringify([f.aid])]);
  // An unassigned resolved case remains outside the viewer's attendance scope.
  assert.equal((await app.fetch(new Request(url,{headers:{cookie:'session=viewer-session'}}))).status,403);
  const html=messageContent({id:mid,kind:'image',media:{id:'456',caption:'<script>bad</script>'},reactions:[{emoji:'👍'}]},v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;'));
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('message-reaction'));assert.ok(!html.includes('PRIVATE'));assert.ok(html.includes('/api/messages/'));
 }finally{delete globalThis.__acquarellaPool;await f.db.close();}
});
