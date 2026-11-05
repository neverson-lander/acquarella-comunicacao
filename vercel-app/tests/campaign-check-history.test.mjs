import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createCampaignChecks} from '../lib/campaign-checks.mjs';
import {createCrm} from '../lib/crm-store.mjs';
test('same ad returns retain independent immutable matched reports and CRM only exposes the permitted tenant',async()=>{
 const db=new PGlite(),pool={query:(sql,args=[])=>db.query(sql,args)},tenant=randomUUID(),account=randomUUID(),conversation=randomUUID(),uid=randomUUID(),user={tenant,id:uid,role:'admin'};
 try{
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await db.query("insert into tenants(id,name,phone) values($1,'Teste','5534999999999')",[tenant]);
  await db.query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Agenda','whatsapp','{}','live')",[account,tenant]);
  await db.query("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Equipe','history@test.invalid','unused','admin')",[uid,tenant]);
  await db.query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,'5534999998888','Maria','resolved',1,1)",[conversation,tenant,account]);
  await db.query("insert into crm_contacts(id,tenant,name,created) values($1,$2,'Maria',1)",[uid,tenant]);
  await db.query('insert into crm_opportunities(tenant,contact,conversation,first_contact,updated) values($1,$2,$3,1,1)',[tenant,uid,conversation]);
  const checks=createCampaignChecks({pool});
  const report=since=>({ad_id:'ad1',since,status:'matched',checked_at:100,matches:[{id:String(since),created_at:since+1,services:['Manicure']}]});
  await checks.save(user,conversation,report(1));await checks.save(user,conversation,report(10));
  const preserved=await checks.save(user,conversation,{...report(1),status:'none_in_period',matches:[]});
  assert.equal(preserved.status,'matched');assert.equal(preserved.matches[0].id,'1');
  assert.equal((await db.query('select report from cashbarber_campaign_checks')).rows[0].report.since,10,'querying an old attendance never replaces the current attendance');
  assert.equal((await db.query('select count(*)::int as n from cashbarber_campaign_check_history')).rows[0].n,2);
  const crm=createCrm({pool,permitted:()=>true});const state=await crm.state(user);assert.equal(state.campaign_checks.length,2);
  const foreign=await crm.state({...user,tenant:randomUUID()});assert.equal(foreign.campaign_checks.length,0);
 }finally{await db.close();}
});
