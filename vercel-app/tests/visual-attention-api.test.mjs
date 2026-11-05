import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,randomBytes,createHash,createCipheriv} from 'node:crypto';
test('visual notification minutes are persisted per channel, validated and exposed to authorized attendants',async()=>{
 const db=new PGlite(),tenant=randomUUID(),other=randomUUID(),account=randomUUID(),second=randomUUID(),foreign=randomUUID(),key=randomBytes(32);
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 try{
  for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort().filter(name=>name!=='202610240006_split_visual_attention.sql'))await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  await query("insert into tenants(id,name,phone) values($1,'Test','5534999999999'),($2,'Other','5534888888888')",[tenant,other]);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([cipher.update('{}'),cipher.final()]),secret=Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
  for(const [id,t]of [[account,tenant],[second,tenant],[foreign,other]])await query("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Atendimento','whatsapp',$3,'demo')",[id,t,secret]);
  await query('update accounts set visual_alert_minutes=12 where id=$1',[account]);await db.exec(await readFile(new URL('../supabase/migrations/202610240006_split_visual_attention.sql',import.meta.url),'utf8'));
  for(const role of ['admin','agent','viewer']){const uid=randomUUID();await query('insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,$3,$4,$5,$3,$6)',[uid,tenant,role,role+'@test.invalid','unused',JSON.stringify([account,second])]);await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(role).digest('hex'),uid,Date.now()+60000]);}
  globalThis.__acquarellaPool={query,connect:async()=>({query,release(){}})};process.env.APP_ENCRYPTION_KEY=key.toString('base64');const {default:app}=await import('../api/index.mjs');
  const request=(path,input,role='admin')=>app.fetch(new Request('https://test.invalid/api/'+path,{method:input?'POST':'GET',headers:{cookie:'session='+role,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})}));
  const save=(id,queueMinutes,assignedMinutes,role)=>request('accounts/'+id+'/visual-alerts',{queueMinutes,assignedMinutes},role);
  const values=async id=>(await query('select visual_queue_minutes,visual_assigned_minutes from accounts where id=$1',[id])).rows[0];
  assert.deepEqual(await values(account),{visual_queue_minutes:12,visual_assigned_minutes:12});
  assert.equal((await save(account,7,20)).status,200);
  assert.deepEqual(await values(account),{visual_queue_minutes:7,visual_assigned_minutes:20});
  assert.deepEqual(await values(second),{visual_queue_minutes:30,visual_assigned_minutes:30});
  for(const value of [0,1441,1.5,null,'5',undefined]){assert.equal((await save(account,value,20)).status,400);assert.equal((await save(account,7,value)).status,400);}
  assert.deepEqual(await values(account),{visual_queue_minutes:7,visual_assigned_minutes:20});
  for(const role of ['agent','viewer'])assert.equal((await save(account,5,20,role)).status,403);
  assert.equal((await save(foreign,5,20)).status,403);
  const response=await request('state',undefined,'agent');assert.equal(response.status,200);const state=await response.json();assert.equal(state.accounts.find(a=>a.id===account).visual_queue_minutes,7);assert.equal(state.accounts.find(a=>a.id===account).visual_assigned_minutes,20);assert.ok(!state.accounts.some(a=>a.id===foreign));
  assert.equal((await request('accounts/'+account+'/visual-alerts',{minutes:9})).status,200);assert.deepEqual(await values(account),{visual_queue_minutes:9,visual_assigned_minutes:9});
  assert.match((await query('select action from audit')).rows[0].action,/Prazo dos avisos visuais/);
 }finally{delete globalThis.__acquarellaPool;await db.close();}
});
