import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createInboundHandler} from '../lib/sac-inbound.mjs';
import {createMessageTiming} from '../public/message-timing.mjs';

test('incoming arrival precedes profile work, survives retries, and preserves provider send time on all channels',async()=>{
  const db=new PGlite(),tenant=randomUUID(),sent=Date.parse('2026-10-30T23:59:58-03:00');let now=sent+7000;
  const query=(sql,args=[])=>db.query(sql,args),one=async(sql,args)=>(await query(sql,args)).rows[0];
  try{
    for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
    await query("insert into tenants(id,name,phone) values($1,'Test','5534999999999')",[tenant]);
    const handler=createInboundHandler({one,run:query,id:randomUUID,now:()=>now,profile:async()=>{now+=30000;return {name:'Cliente'};},capture:async()=>{now+=5000;},open:()=>({}),send:async()=>{},queue:async()=>{},audit:async()=>{}});
    for(const channel of ['whatsapp','instagram','messenger']){
      const aid=randomUUID();await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'Test',$3,'provider','{}','live')",[aid,tenant,channel]);
      const account=await one('select * from accounts where id=$1',[aid]),arrival=now;
      const payload=channel==='whatsapp'?{entry:[{changes:[{value:{metadata:{phone_number_id:'provider'},messages:[{id:'msg',from:'5534888888888',timestamp:String(sent/1000),type:'text',text:{body:'Olá'}}]}}]}]}:{entry:[{id:'provider',messaging:[{sender:{id:'client'},timestamp:sent,message:{mid:'msg',text:'Olá'}}]}]};
      await handler(account,payload);now+=60000;await handler(account,payload);
      const rows=(await query('select m.* from messages m join conversations c on c.id=m.conversation where c.account=$1',[aid])).rows;
      assert.equal(rows.length,1);assert.equal(Number(rows[0].created),sent);assert.equal(Number(rows[0].received_at),arrival);
      // Legacy messages keep an unknown arrival rather than a fabricated one.
      const legacy=await one("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in','Antiga',$3,'received') returning received_at",[randomUUID(),rows[0].conversation,sent-86400000]);
      assert.equal(legacy.received_at,null);
    }
  }finally{await db.close();}
});


test('first view comes from persisted data, independent of user, session and computer time',()=>{
  const original=Date.now,stamp=Date.parse('2026-10-31T00:00:07-03:00');
  const message={id:'m',direction:'in',created:stamp-9000,received_at:String(stamp-2000),first_viewed_at:String(stamp)};
  try{
    for(const skew of [-458000,458000]){
      Date.now=()=>stamp+skew;
      const timing=createMessageTiming(),html=timing(message,'tenant:user:chat');
      assert.match(html,/Enviada pelo cliente: <time[^>]+>30\/10\/2026 23:59:58/);
      assert.match(html,/Recebida na central: <time[^>]+>31\/10\/2026 00:00:05/);
      assert.match(html,/Primeira visualização: <time[^>]+>31\/10\/2026 00:00:07/);
      assert.equal(timing({...message,direction:'out'},'tenant:user:chat'),'');
      assert.match(createMessageTiming()(message,'tenant:other:chat'),/Primeira visualização: <time[^>]+>31\/10\/2026 00:00:07/);
      for(const value of [null,undefined,0,'invalid',-1])assert.match(timing({...message,first_viewed_at:value},'tenant:user:chat'),/Primeira visualização: ainda não registrada/);
      assert.match(html,/popovertarget=/);
    }
  }finally{Date.now=original;}
});
