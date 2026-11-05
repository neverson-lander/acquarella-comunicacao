import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createCashbarber} from '../lib/cashbarber-store.mjs';

test('CashBarber import is channel/tenant scoped, repeatable and preserves opt-out, manual data and tags; creation requires writable attendance',async()=>{
 const db=new PGlite(),query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},pool={query,connect:async()=>({query,release(){}})};
 const tenant=randomUUID(),other=randomUUID(),account=randomUUID(),foreign=randomUUID(),uid=randomUUID(),cid=randomUUID(),audit=[];
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  for(const id of [tenant,other])await query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[id]);
  for(const [id,t]of [[account,tenant],[foreign,other]])await query("insert into accounts(id,tenant,name,channel,secret) values($1,$2,'Atendimento Acquarella','whatsapp','{}')",[id,t]);
  await query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Ana','ana@test.invalid','none','admin')",[uid,tenant]);
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,'5534999998888','Cliente','open',0,0,$4)",[cid,tenant,account,uid]);
  const old=(await query("insert into crm_contacts(tenant,account,name,phone,email,notes,campaign_excluded,name_manual,active,created) values($1,$2,'Nome manual','5534999998888','manual@test.invalid','Observação manual',true,true,false,0) returning id",[tenant,account])).rows[0];
  const pages=[[{id:'1',name:'Nome externo',phone:'(34) 99999-8888',email:'externo@test.invalid',active:true},{id:'2',name:'Nova',phone:'34977776666',email:'nova@test.invalid',active:true},{id:'3',name:'Duplicada',phone:'3477776666',email:'',active:true},{id:'4',name:'Inválida',phone:'123',active:true}],[{id:'5',name:'Desativada',phone:'34966665555',email:'',active:false}]];
  const calls=[],client={configured:()=>true,call:async(t,action,input)=>{assert.equal(t,tenant);calls.push({action,input});if(action==='customer-page')return {clients:pages[input.page],page:input.page,total:5,lastPage:2};if(action==='create-client')return {state:'confirmed',client:{id:'6',name:'Novo cadastro',phone:'34955554444',email:'novo@test.invalid',active:true}};throw Error('Unexpected action');}};
  const user={id:uid,tenant,name:'Ana',role:'admin'},conversation={id:cid,tenant,account,status:'open',assigned_to:uid};
  const store=createCashbarber({pool,client,audit:async(t,m)=>audit.push(m),getConversation:async()=>conversation});
  const call=(action,input={},u=user)=>store.route(u,'/api/cashbarber/'+action,{conversation:cid,...input});
  await assert.rejects(call('import-contacts',{account,page:0},{...user,role:'receptionist'}),e=>e.status===403);
  await assert.rejects(call('import-contacts',{account:foreign,page:0}),e=>e.status===403);assert.equal(calls.length,0);
  const first=await call('import-contacts',{account,page:0});assert.equal(first.created,1);assert.equal(first.existing,2);assert.equal(first.skipped.length,1);
  const second=await call('import-contacts',{account,page:1});assert.equal(second.created,1);
  const replay=await call('import-contacts',{account,page:0});assert.equal(replay.created,0);assert.equal(replay.existing,3);
  const saved=(await query('select * from crm_contacts where id=$1',[old.id])).rows[0];assert.equal(saved.name,'Nome manual');assert.equal(saved.email,'manual@test.invalid');assert.equal(saved.notes,'Observação manual');assert.equal(saved.campaign_excluded,true);assert.equal(saved.active,false);
  const fresh=(await query("select * from crm_contacts where tenant=$1 and name='Nova'",[tenant])).rows[0];assert.equal(fresh.campaign_excluded,false);assert.equal((await query('select * from cashbarber_contact_links where contact=$1',[fresh.id])).rows.length,2);
  assert.equal((await query("select active from crm_contacts where name='Desativada'")).rows[0].active,false);
  const create={operation:randomUUID(),name:'Novo cadastro',phone:'34955554444',email:'novo@test.invalid',password:'test-only-password',birthDate:'1990-01-01',source:'Site'};
  await assert.rejects(call('create-client',create,{...user,role:'viewer'}),e=>e.status===403);
  conversation.assigned_to=null;await assert.rejects(call('create-client',create),e=>e.status===403);conversation.assigned_to=uid;
  assert.equal((await call('create-client',create)).state,'confirmed');assert.equal((await query("select * from cashbarber_contact_links where client_id='6'")).rows.length,1);
  await query('update accounts set enabled=false where id=$1',[account]);await assert.rejects(call('create-client',create),e=>e.status===409);
  assert.ok(audit.every(m=>!m.includes(create.password)));
 }finally{await db.close();}
});
