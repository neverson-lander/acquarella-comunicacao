import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {repairRevocations} from '../../artifacts/whatsapp-unsupported/repair-lib.mjs';
import {createWhatsAppContent} from '../lib/whatsapp-content.mjs';
import {messageContent} from '../public/message-content.js';

test('historical repair is scoped, reversible by backup, idempotent, and removes only confirmed protocol placeholders',async()=>{
 const db=new PGlite(),tenant=randomUUID(),aid=randomUUID(),otherAid=randomUUID(),cid=randomUUID(),otherCid=randomUUID(),uid=randomUUID(),customer='5534999999999',now=Date.now();
 const query=(sql,args=[])=>db.query(sql,args),account={id:aid,tenant},counts=()=>query('select count(*)::int as n from messages');
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await query("insert into tenants(id,name,phone) values($1,'Test',$2)",[tenant,customer]);
  await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Ana','test@test.invalid','unused','admin')",[uid,tenant]);
  await query("insert into accounts(id,tenant,name,channel,mode,secret) values($1,$2,'WA','whatsapp','live','{}'),($3,$2,'Other','whatsapp','live','{}')",[aid,tenant,otherAid]);
  for(const [id,a] of [[cid,aid],[otherCid,otherAid]])await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,$4,'Cliente','open',$5,$5,$6)",[id,tenant,a,customer,now,uid]);
  const placeholder='[Conteúdo não suportado: consulte o WhatsApp]',original=randomUUID(),ghost=randomUUID(),referenced=randomUUID();
  for(const [id,c,external,body,stamp] of [[original,cid,aid+':original','Original private content',now-10000],[ghost,cid,aid+':delete1',placeholder,now-5000],[referenced,cid,aid+':delete3',placeholder,now-6000],[randomUUID(),cid,aid+':delete2','Different text must remain',now-9000],[randomUUID(),otherCid,'delete1',placeholder,now-5000]])await query("insert into messages(id,conversation,direction,body,created,state,external) values($1,$2,'in',$3,$4,'received',$5)",[id,c,body,stamp,external]);
  await query("insert into message_operations(id,tenant,kind,source_message,actor,actor_name,input,snapshot,state,created,updated) values($1,$2,'forward',$3,$4,'Ana','{}','{}','failed',$5,$5)",[randomUUID(),tenant,referenced,uid,now]);
  const events=['delete1','delete2','delete3'].map(external=>({external,customer,timestamp:now-5000,target:'original'})),content=createWhatsAppContent({pool:{query}}),args={db:{query},account,events,captureDeletion:(a,m)=>content.captureDeletion(a,m)};
  const dry=await repairRevocations(args);assert.equal(dry.placeholders,2);assert.equal(dry.referenced,1);assert.equal((await counts()).rows[0].n,5);assert.equal((await query('select count(*)::int as n from whatsapp_deletions')).rows[0].n,0);
  const applied=await repairRevocations({...args,apply:true});assert.equal(applied.removed,1);assert.equal((await counts()).rows[0].n,4);
  const originalRow=(await query('select * from messages where id=$1',[original])).rows[0],deletion=(await query('select * from whatsapp_deletions')).rows[0];assert.equal(originalRow.body,'Original private content');assert.equal(deletion.target_external,'original');
  const rendered=messageContent({...originalRow,deletion},s=>String(s));assert.match(rendered,/Excluída no WhatsApp/);
  const c=(await query('select * from conversations where id=$1',[cid])).rows[0];assert.equal(c.assigned_to,uid);assert.equal(c.status,'open');assert.equal(Number(c.updated),now);assert.equal(Number(c.last_inbound),now-6000);
  assert.equal((await repairRevocations({...args,apply:true})).removed,0);assert.equal((await query('select count(*)::int as n from whatsapp_deletions')).rows[0].n,1);
  await assert.rejects(repairRevocations({...args,events:[{...events[0],customer:'invalid'}],apply:true}),/Invalid/);
 }finally{await db.close();}
});
