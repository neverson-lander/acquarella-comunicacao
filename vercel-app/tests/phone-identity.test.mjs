import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {contactPhoneVariants} from '../public/contact-domain.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {createCrm} from '../lib/crm-store.mjs';
import {whatsappCustomerPhone} from '../lib/whatsapp-conversation.mjs';

test('ordinary arrivals reuse contacts and conversations for either ninth-digit form, including simultaneous arrivals',async()=>{
 const db=new PGlite(),query=(sql,args=[])=>db.query(sql,args);let pending=Promise.resolve();
 const pool={query,connect:async()=>{const before=pending;let release;pending=new Promise(r=>{release=r;});await before;return {query,release};}};
 const tenant=randomUUID(),foreign=randomUUID(),aid=randomUUID(),otherAid=randomUUID(),time=Date.now();
 try{
  for(const f of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  for(const id of [tenant,foreign])await query("insert into tenants(id,name,phone) values($1,'Teste','5534988748139')",[id]);
  for(const [id,t]of [[aid,tenant],[otherAid,foreign]])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'WhatsApp','whatsapp','qr','live')",[id,t]);
  const account=(await query('select * from accounts where id=$1',[aid])).rows[0];
  const crm=createCrm({pool,permitted:()=>true,open:()=>({}),now:()=>time});
  const handler=createInboundHandler({one:async(s,v)=>(await query(s,v)).rows[0],run:query,id:randomUUID,now:()=>time,profile:async()=>({}),capture:crm.capture,queue:async()=>{throw Error('No forwarding');}});
  const receive=(phone)=>handler(account,{entry:[{changes:[{value:{metadata:{phone_number_id:account.external},contacts:[{wa_id:phone,profile:{name:'Cliente WhatsApp'}}],messages:[{id:randomUUID(),from:phone,timestamp:String(Math.floor(time/1000)),type:'text',text:{body:'Olá'}}]}}]}]});
  for(const [i,simultaneous]of [[0,false],[1,true]]){
   const full='553498809240'+i,legacy=full.slice(0,4)+full.slice(5),contact=randomUUID();
   await query("insert into crm_contacts(id,tenant,account,name,phone,notes,name_manual,created) values($1,$2,$3,'Nome manual',$4,'Preservar notas',true,$5)",[contact,tenant,aid,legacy,time-10000]);
   await query("insert into crm_contacts(tenant,account,name,phone,created) values($1,$2,'Outro tenant',$3,$4)",[foreign,otherAid,full,time]);
   if(simultaneous)await Promise.all([receive(full),receive(legacy)]);else{await receive(legacy);await receive(full);}
   const rows=(await query('select * from conversations where tenant=$1 and account=$2 and customer=$3',[tenant,aid,full])).rows;assert.equal(rows.length,1);
   assert.equal(Number((await query('select count(*) as total from messages where conversation=$1',[rows[0].id])).rows[0].total),2);
   assert.equal((await query('select contact from crm_opportunities where conversation=$1',[rows[0].id])).rows[0].contact,contact);
   const saved=(await query('select * from crm_contacts where id=$1',[contact])).rows[0];assert.equal(saved.name,'Nome manual');assert.equal(saved.notes,'Preservar notas');
  }
  const full='5534988092402',legacy=full.slice(0,4)+full.slice(5),cid=randomUUID();
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,$4,'Existente','resolved',$5,0)",[cid,tenant,aid,legacy,time-1000]);
  await receive(full);assert.equal(Number((await query('select count(*) as total from messages where conversation=$1',[cid])).rows[0].total),1);
  assert.equal(Number((await query('select count(*) as total from conversations where tenant=$1',[tenant])).rows[0].total),3);
  assert.deepEqual(contactPhoneVariants('553432111234'),['553432111234']);assert.deepEqual(contactPhoneVariants('155512345678'),['155512345678']);
  for(const phone of ['15551234567','447700900123','553432111234'])assert.equal(whatsappCustomerPhone(phone),phone);
 }finally{await db.close();}
});
