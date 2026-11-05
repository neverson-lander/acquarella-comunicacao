import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';

test('active outreach API uses the registered channel, preserves windows and ownership, and sends each request once',async()=>{
 const db=new PGlite(),tenant=randomUUID(),other=randomUUID(),key=randomBytes(32),calls=[];
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);for(const f of r.fields||[])if(f.dataTypeID===20)for(const row of r.rows)if(row[f.name]!==null)row[f.name]=Number(row[f.name]);return {...r,rowCount:r.affectedRows??r.rows.length};};
 for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
 globalThis.__acquarellaPool={query,connect:async()=>({query,release(){}})};
 process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.WHATSAPP_QR_URL='https://gateway.test';process.env.WHATSAPP_QR_SECRET='q'.repeat(40);
 const seal=v=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(JSON.stringify(v)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');};
 const qr=randomUUID(),meta=randomUUID(),ig=randomUUID(),foreign=randomUUID();
 await query("insert into tenants(id,name,phone) values($1,'Tenant','5534888888888'),($2,'Other','5534888888888')",[tenant,other]);
 for(const [id,t,channel,secret]of [[qr,tenant,'whatsapp',{transport:'qr'}],[meta,tenant,'whatsapp',{}],[ig,tenant,'instagram',{}],[foreign,other,'whatsapp',{transport:'qr'}]])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,$3,$4,$5,'live')",[id,t,id,channel,seal(secret)]);
 const users={};for(const role of ['admin','receptionist','agent','agent2','viewer','outsider']){const id=randomUUID(),t=role==='outsider'?other:tenant;users[role]=id;await query("insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,'unused',$5,$6)",[id,t,role,role+'@test.invalid',role==='agent2'?'agent':role==='outsider'?'admin':role,JSON.stringify([qr,meta,ig])]);await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(role).digest('hex'),id,Date.now()+3600000]);}
 const contacts={};for(const [name,account,t,phone]of [['Maria',qr,tenant,'5534998765432'],['Meta',meta,tenant,'5534998765433'],['Instagram',ig,tenant,'5534998765434'],['Foreign',foreign,other,'5534998765432']]){const id=randomUUID();contacts[name]=id;await query('insert into crm_contacts(id,tenant,name,account,phone,email,created) values($1,$2,$3,$4,$5,$6,$7)',[id,t,name,account,phone,name+'@test.invalid',Date.now()]);}
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{calls.push({url:String(url),input:JSON.parse(options.body)});return Response.json(String(url).startsWith('https://gateway.test')?{external:'qr-'+calls.length}:{messages:[{id:'meta-'+calls.length}]});};
 try{
  const {default:app}=await import('../api/index.mjs');
  const api=async(path,body,user='agent')=>{const r=await app.fetch(new Request('https://test.invalid/api/'+path,{method:body?'POST':'GET',headers:{cookie:'session='+user,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));return {status:r.status,body:await r.json()};};
  assert.equal((await api('outreach/search?q=Maria',undefined,'viewer')).status,403);
  const search=await api('outreach/search?q=9876');assert.equal(search.body.items.length,3);assert.ok(search.body.items.every(c=>c.id!==contacts.Foreign));assert.ok(!JSON.stringify(search.body).includes('secret'));
  assert.equal((await api('outreach/search?q=maria%40test.invalid')).body.items[0].id,contacts.Maria);
  const input={id:randomUUID(),contact:contacts.Maria,body:'Olá, Maria!'};
  assert.equal((await api('outreach/send',input,'outsider')).status,404);
  const sent=await api('outreach/send',input);assert.equal(sent.status,200);assert.equal(sent.body.state,'sent');assert.equal(calls.length,1);assert.ok(calls[0].url.includes(qr));assert.equal(calls[0].input.recipient,'5534998765432');
  const c=(await query('select * from conversations where id=$1',[sent.body.conversation])).rows[0];assert.equal(c.assigned_to,users.agent);assert.equal(c.last_inbound,0);
  assert.equal((await api('outreach/send',input)).status,200);assert.equal(calls.length,1);
  assert.equal((await api('outreach/send',{...input,body:'Texto diferente'})).status,409);
  assert.equal((await api('outreach/send',{...input,id:randomUUID()},'agent2')).status,409);
  assert.equal((await api('outreach/send',{...input,id:randomUUID()},'admin')).status,409);
  assert.equal((await api('outreach/contact/'+contacts.Meta)).body.canSend,false);
  assert.equal((await api('outreach/contact/'+contacts.Instagram)).body.canSend,false);
  const metaC=randomUUID();await query("insert into conversations(id,tenant,account,customer,name,status,last_inbound,updated) values($1,$2,$3,'5534998765433','Meta','resolved',$4,$4)",[metaC,tenant,meta,Date.now()]);
  const metaSent=await api('outreach/send',{id:randomUUID(),contact:contacts.Meta,body:'Retorno'});assert.equal(metaSent.status,200);assert.equal(metaSent.body.state,'sent');assert.ok(calls.at(-1).url.startsWith('https://graph.facebook.com/'));
  await query('update conversations set last_inbound=$1 where id=$2',[Date.now()-86400000,metaC]);assert.equal((await api('outreach/contact/'+contacts.Meta)).body.canSend,false);
  await query('update crm_contacts set active=false where id=$1',[contacts.Maria]);assert.equal((await api('outreach/send',{...input,id:randomUUID()})).status,409);
  await query('update crm_contacts set active=true where id=$1',[contacts.Maria]);await query('update accounts set enabled=false where id=$1',[qr]);assert.equal((await api('outreach/send',{...input,id:randomUUID()})).status,409);
  await query('update accounts set enabled=true,deleted_at=$1 where id=$2',[Date.now(),qr]);assert.equal((await api('outreach/contact/'+contacts.Maria)).status,403);
  assert.equal((await query('select count(*) as n from contact_outreach')).rows[0].n,2);
 }finally{globalThis.fetch=original;delete globalThis.__acquarellaPool;await db.close();}
});
