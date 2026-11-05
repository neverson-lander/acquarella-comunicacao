import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';

test('real API records the first authorized viewer atomically, preserves it across sessions, and respects access and incremental sync',async()=>{
 const db=new PGlite(),stamp=Date.now(),key=randomBytes(32),tenant=randomUUID(),other=randomUUID(),aid=randomUUID(),cid=randomUUID(),mid=randomUUID(),out=randomUUID(),unseen=randomUUID(),foreignMessage=randomUUID(),users={};
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 try{
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  const seal=value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');};
  await query("insert into tenants(id,name,phone) values($1,'Test','5534999999999'),($2,'Other','5534888888888')",[tenant,other]);
  for(const role of ['admin','receptionist','agent','viewer','noAccount','foreign']){
   const id=randomUUID();users[role]=id;
   await query('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$6,$7)',[id,role==='foreign'?other:tenant,role,role+'@test.invalid','unused',['noAccount','foreign'].includes(role)?'agent':role,JSON.stringify(role==='noAccount'?[]:[aid])]);
   await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(role).digest('hex'),id,stamp+3600000]);
  }
  await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'WA','whatsapp','provider',$3,'live')",[aid,tenant,seal({token:'test'})]);
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'client','Cliente','open',$4,$4,$5)",[cid,tenant,aid,stamp-86400000,users.admin]);
  for(const [id,direction] of [[mid,'in'],[out,'out'],[unseen,'in']])await query("insert into messages(id,conversation,direction,body,created,state,received_at) values($1,$2,$3,'Test',$4,'received',$4)",[id,cid,direction,stamp-1000]);
  const otherCid=randomUUID();await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,'other','Other','open',$4,$4)",[otherCid,tenant,aid,stamp]);await query("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in','Other',$3,'received')",[foreignMessage,otherCid,stamp]);
  globalThis.__acquarellaPool={query,connect:async()=>({query,release(){}})};process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.PUBLIC_ORIGIN='https://test.invalid';
  const {default:app}=await import('../api/index.mjs');
  const request=(body,role='admin',conversation=cid)=>app.fetch(new Request(`https://test.invalid/api/conversations/${conversation}/messages/first-view`,{method:'POST',headers:{cookie:'session='+role,'content-type':'application/json'},body:JSON.stringify(body)}));
  for(const role of ['noAccount','foreign','agent','viewer','missing'])assert.ok([401,403,404].includes((await request({ids:[mid]},role)).status));
  assert.equal((await request({ids:['invalid']})).status,400);assert.equal((await request({ids:Array(101).fill(mid)})).status,400);
  await query("update conversations set status='resolved' where id=$1",[cid]);
  const results=await Promise.all(['admin','receptionist'].map(role=>request({ids:[mid,out,foreignMessage],first_viewed_at:1},role)));
  const data=await Promise.all(results.map(r=>{assert.equal(r.status,200);return r.json();}));
  assert.equal(data[0].messages.length,1);assert.deepEqual(data[0],data[1]);
  const first=data[0].messages[0].first_viewed_at;assert.ok(first>=stamp&&first<=Date.now());
  const stored=(await query('select * from messages where id=$1',[mid])).rows[0];assert.equal(Number(stored.first_viewed_at),first);assert.ok([users.admin,users.receptionist].includes(stored.first_viewed_by));
  assert.equal((await request({ids:[mid]},'admin')).status,200);assert.equal(Number((await query('select first_viewed_at from messages where id=$1',[mid])).rows[0].first_viewed_at),first);
  for(const id of [out,unseen,foreignMessage])assert.equal((await query('select first_viewed_at from messages where id=$1',[id])).rows[0].first_viewed_at,null);
  const response=await app.fetch(new Request('https://test.invalid/api/state?since='+stamp,{headers:{cookie:'session=admin'}}));assert.equal(response.status,200);
  const snapshot=await response.json();assert.equal(snapshot.partial,true);assert.equal(snapshot.conversations.find(c=>c.id===cid).messages.find(m=>m.id===mid).first_viewed_at,first);
  assert.equal(Number((await query('select updated from conversations where id=$1',[cid])).rows[0].updated),stamp-86400000);
  // View-only accounts may record a view in a queue they can actually access.
  assert.equal((await request({ids:[foreignMessage]},'viewer',otherCid)).status,200);
 }finally{delete globalThis.__acquarellaPool;await db.close();}
});
