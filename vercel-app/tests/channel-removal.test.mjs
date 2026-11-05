import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createChannelRemoval} from '../lib/channel-removal.mjs';

test('channel removal retains history, isolates tenants, stops delivery and disconnects only its QR session',async()=>{
  const db=new PGlite(),query=(sql,args=[])=>db.query(sql,args),pool={query,connect:async()=>({query,release(){}})},tenant=randomUUID(),other=randomUUID(),uid=randomUUID(),aid=randomUUID(),bridge=randomUUID(),cid=randomUUID(),mid=randomUUID(),job=randomUUID();
  try{
    for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
    await query("insert into tenants values($1,'Empresa','5511999999999'),($2,'Outra','5511888888888')",[tenant,other]);
    await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Ana','admin@test.invalid','unused','admin')",[uid,tenant]);
    await query("insert into accounts(id,tenant,name,channel,external,secret,mode) values($1,$2,'WhatsApp antigo','whatsapp',$3,'{\"transport\":\"qr\"}','live')",[aid,tenant,aid]);
    await query("insert into accounts(id,tenant,name,channel,secret,mode,bridge,forwarding_enabled,alerts_enabled) values($1,$2,'Instagram','instagram','{}','live',$3,true,true)",[bridge,tenant,aid]);
    await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5511777777777','Cliente','open',100,100,$4)",[cid,tenant,aid,uid]);
    await query("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'out','Resposta pendente',100,'queued')",[mid,cid]);
    await query("insert into jobs(id,tenant,account,conversation,message,kind,recipient,body,state,created) values($1,$2,$3,$4,$5,'reply','5511777777777','Resposta pendente','pending',100)",[job,tenant,aid,cid,mid]);
    const user={id:uid,tenant,role:'admin',name:'Ana'},input={name:'WhatsApp antigo',confirmed:true},disconnected=[];
    const create=disconnect=>createChannelRemoval({pool,permitted:(u,a)=>u.tenant===a.tenant,usesQr:a=>JSON.parse(a.secret).transport==='qr',now:()=>1000,disconnect});
    const removal=create(async a=>{
      assert.equal((await query('select enabled from accounts where id=$1',[a.id])).rows[0].enabled,false);
      assert.equal((await query('select state from jobs where id=$1',[job])).rows[0].state,'cancelled');disconnected.push(a.id);
    });
    for(const role of ['agent','receptionist','viewer'])await assert.rejects(removal.remove({...user,role},aid,input),e=>e.status===403);
    await assert.rejects(removal.remove({...user,tenant:other},aid,input),e=>e.status===403);
    await assert.rejects(removal.remove(user,aid,{name:input.name}),e=>e.status===400);
    await assert.rejects(removal.remove(user,aid,{...input,name:'Different channel'}),e=>e.status===409);
    await query("update jobs set state='sending' where id=$1",[job]);await assert.rejects(removal.remove(user,aid,input),e=>e.status===409);await query("update jobs set state='pending' where id=$1",[job]);
    const booking=randomUUID();await query("insert into cashbarber_bookings(id,tenant,conversation,actor,state,quote,created,updated,expires) values($1,$2,$3,$4,'uncertain','{}',100,100,100)",[booking,tenant,cid,uid]);
    await assert.rejects(removal.remove(user,aid,input),e=>e.status===409);await query("update cashbarber_bookings set state='rejected' where id=$1",[booking]);
    const broken=create(async()=>{throw Error('Gateway offline');});await assert.rejects(broken.remove(user,aid,input),e=>e.status===502);
    const disabled=(await query('select * from accounts where id=$1',[aid])).rows[0];assert.equal(disabled.enabled,false);assert.equal(disabled.deleted_at,null);
    assert.equal((await query('select bridge from accounts where id=$1',[bridge])).rows[0].bridge,aid);
    const result=await removal.remove(user,aid,input);assert.equal(result.closed,1);assert.equal(result.affected,1);assert.deepEqual(disconnected,[aid]);
    const deleted=(await query('select * from accounts where id=$1',[aid])).rows[0];assert.equal(Number(deleted.deleted_at),1000);assert.equal(deleted.external,'');
    const dependent=(await query('select * from accounts where id=$1',[bridge])).rows[0];assert.equal(dependent.bridge,null);assert.equal(dependent.forwarding_enabled,false);assert.equal(dependent.alerts_enabled,false);assert.equal(dependent.enabled,true);
    assert.equal((await query('select status from conversations where id=$1',[cid])).rows[0].status,'resolved');
    assert.equal((await query('select body,state from messages where id=$1',[mid])).rows[0].body,'Resposta pendente');
    assert.equal((await query('select state from messages where id=$1',[mid])).rows[0].state,'failed');
    assert.equal((await query('select * from attendance_history where conversation=$1',[cid])).rows[0].action,'Canal excluído: atendimento encerrado');
    assert.ok((await query('select action from audit where tenant=$1',[tenant])).rows.some(h=>h.action.includes('Histórico preservado')));
    assert.deepEqual(await removal.remove(user,aid,input),{ok:true});assert.equal(disconnected.length,1);
    assert.equal((await query('select id from cashbarber_bookings where id=$1',[booking])).rows.length,1);
  }finally{await db.close();}
});
