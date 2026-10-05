import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,createHash,randomBytes,createCipheriv} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createWaitingAlerts,alertSettings,authorizedAlertJob,normalizeAlertPhones} from '../lib/waiting-alerts.mjs';
import {createInboundHandler} from '../lib/sac-inbound.mjs';

test('settings validate intervals, preserve absent fields and reject invalid job authorization',()=>{
  assert.deepEqual(alertSettings({},null),{enabled:false,queue:15,assigned:15,phones:[]});
  assert.deepEqual(alertSettings({queueAlertMinutes:'2'},{alerts_enabled:true,assigned_alert_minutes:35,alerts_phones:['5534988748139']}),{enabled:true,queue:2,assigned:35,phones:['5534988748139']});
  for(const value of [0,1441,-1,1.5,'',null,true,'abc'])assert.throws(()=>alertSettings({queueAlertMinutes:value}));
  assert.throws(()=>alertSettings({alertsEnabled:'true'}));
  assert.equal(authorizedAlertJob('Bearer x','x'),true);
  for(const [header,secret] of [[null,'x'],['Bearer wrong','x'],['Bearer ',''],['Bearer undefined',undefined]])assert.equal(authorizedAlertJob(header,secret),false);
});

test('recipient lists normalize formatted phones and deduplicate Brazilian legacy IDs',()=>{
  assert.deepEqual(normalizeAlertPhones(['+55 (34) 98874-8139','5534988748139','553488748139','+1 (202) 555-0100']),['5534988748139','12025550100']);
  for(const phones of [null,'5534988748139',[12],[''],['abc5534988748139'],['5534'],['05534988748139'],Array(21).fill('5534988748139')])assert.throws(()=>normalizeAlertPhones(phones));
  assert.throws(()=>alertSettings({alertsEnabled:true,alertPhones:[]}));
  assert.throws(()=>alertSettings({alertPhones:null}));
});

async function fixture() {
  const db=new PGlite();
  for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort())
    await db.exec((await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));
  const execute=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
  let pending=Promise.resolve();
  const pool={query:execute,connect:async()=>{const previous=pending;let release;pending=new Promise(r=>release=r);await previous;return {query:execute,release};}};
  const tenant=randomUUID(),other=randomUUID(),source=randomUUID(),sender=randomUUID(),operator=randomUUID();
  let time=1791100800000;
  await execute('insert into tenants(id,name,phone) values($1,$2,$3),($4,$5,$6)',[tenant,'Acquarella','5534988748139',other,'Other','5511999990000']);
  await execute("insert into accounts(id,tenant,name,channel,secret,mode,bridge,alerts_enabled,queue_alert_minutes,assigned_alert_minutes) values($1,$2,'Instagram','instagram','unused','live',$3,true,5,10),($3,$2,'WhatsApp','whatsapp','unused','live',null,false,5,10)",[source,tenant,sender]);
  await execute('update accounts set alerts_phones=$1',[JSON.stringify(['5534988748139'])]);
  await execute("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Ana','ana@test.invalid','unused','agent')",[operator,tenant]);
  await execute('insert into bridge_windows(account,phone,seen) values($1,$2,$3)',[sender,'5534988748139',time]);
  const conversation=async({age=20,assigned=false,status='open',name='Maria',account=source,customer=randomUUID(),company=tenant}={})=>{
    const cid=randomUUID();
    await execute('insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound,assigned_to) values($1,$2,$3,$4,$5,$6,$7,$7,$8)',[cid,company,account,customer,name,status,time-age*60000,assigned?operator:null]);
    await execute("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in','Oi',$3,'received')",[randomUUID(),cid,time-age*60000]);return cid;
  };
  const message=(cid,direction,state,age)=>execute('insert into messages(id,conversation,direction,body,created,state) values($1,$2,$3,$4,$5,$6)',[randomUUID(),cid,direction,'Text',time-age*60000,state]);
  const sent=[];
  const worker=createWaitingAlerts({pool,now:()=>time,send:async(a,to,body)=>{sent.push({a,to,body});return randomUUID();}});
  return {db,pool,execute,tenant,other,source,sender,operator,conversation,message,sent,worker,now:()=>time,advance:n=>time+=n*60000};
}

test('queue and assigned waits respect separate thresholds, repeat intervals and confirmed replies',async()=>{
  const f=await fixture();
  try {
    const queue=await f.conversation({age:6,name:'Fila'}),assigned=await f.conversation({age:11,assigned:true,name:'Atribuída'});
    await f.conversation({age:2,name:'Recente'});await f.conversation({status:'resolved',name:'Encerrada'});
    const replied=await f.conversation({name:'Respondida'});await f.message(replied,'out','sent',1);
    const failed=await f.conversation({name:'Falhou'});await f.message(failed,'out','failed',1);
    const simulated=await f.conversation({name:'Simulada'});await f.message(simulated,'out','simulated',1);
    const uncertain=await f.conversation({name:'Incerta'});await f.message(uncertain,'out','uncertain',1);
    assert.deepEqual(await f.worker(),{attempted:1,sent:1,failed:0});
    const text=f.sent[0].body;
    for(const name of ['Fila','Atribuída','Atendente: Ana','Falhou','Simulada','Incerta'])assert.ok(text.includes(name));
    for(const name of ['Respondida','Recente','Encerrada'])assert.ok(!text.includes(name));
    assert.equal(f.sent[0].to,'5534988748139');assert.equal(f.sent[0].a.id,f.sender);
    assert.equal((await f.worker()).sent,0);
    // Additional inbound messages never reset the oldest unanswered wait.
    await f.message(queue,'in','received',0);f.advance(5);
    assert.equal((await f.worker()).sent,1);assert.ok(!f.sent[1].body.includes('Atribuída'));
    await f.message(queue,'out','sent',0);await f.message(assigned,'out','sent',0);
    await f.execute('update conversations set status=$1 where id<>$2 and id<>$3',['resolved',queue,assigned]);
    f.advance(10);assert.equal((await f.worker()).sent,0);
    await f.message(assigned,'in','received',0);f.advance(10);assert.equal((await f.worker()).sent,1);
  }finally{await f.db.close();}
});

test('disabled/demo channels and foreign tenant bridges cannot send; WhatsApp excludes the team itself',async()=>{
  const f=await fixture();
  try {
    await f.conversation();await f.execute('update accounts set alerts_enabled=false where id=$1',[f.source]);assert.equal((await f.worker()).sent,0);
    await f.execute("update accounts set alerts_enabled=true,mode='demo' where id=$1",[f.source]);assert.equal((await f.worker()).sent,0);
    await f.execute("update accounts set mode='live' where id=$1",[f.source]);
    const foreign=randomUUID();await f.execute("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Foreign','whatsapp','unused','live')",[foreign,f.other]);
    await f.execute('update accounts set bridge=$2 where id=$1',[f.source,foreign]);assert.equal((await f.worker()).failed,1);assert.equal(f.sent.length,0);
    await f.execute('update accounts set alerts_enabled=false where id=$1',[f.source]);
    await f.execute('update accounts set alerts_enabled=true where id=$1',[f.sender]);
    await f.conversation({account:f.sender,customer:'553488748139',name:'Equipe'});assert.equal((await f.worker()).sent,0);
    await f.conversation({account:f.sender,name:'Cliente WhatsApp'});assert.equal((await f.worker()).sent,1);assert.ok(!f.sent[0].body.includes('Equipe'));
  }finally{await f.db.close();}
});

test('closed WhatsApp window and uncertain sends are recorded and throttled, with persistent concurrent claims',async()=>{
  const f=await fixture();
  try {
    await f.conversation();await f.execute('delete from bridge_windows');
    assert.equal((await f.worker()).failed,1);assert.equal(f.sent.length,0);assert.equal((await f.worker()).attempted,0);
    await f.execute('insert into bridge_windows(account,phone,seen) values($1,$2,$3)',[f.sender,'5534988748139',f.now()]);f.advance(5);
    const results=await Promise.all([f.worker(),f.worker()]);assert.equal(results.reduce((s,r)=>s+r.sent,0),1);
    f.advance(5);
    const failing=createWaitingAlerts({pool:f.pool,now:f.now,send:async()=>{throw Error('Timeout');}});
    assert.equal((await failing()).failed,1);
    assert.equal((await f.execute("select count(*) as n from jobs where kind='waiting_alert' and state='uncertain'")).rows[0].n,1);
    assert.equal((await f.worker()).attempted,0);
    await f.execute("insert into jobs(id,tenant,account,conversation,kind,recipient,body,state,error,created) select $1,tenant,account,conversation,kind,recipient,body,'sending','',$2 from jobs limit 1",[randomUUID(),f.now()-180000]);
    await f.worker();assert.equal((await f.execute("select count(*) as n from jobs where state='sending'")).rows[0].n,0);
  }finally{await f.db.close();}
});

test('each recipient has its own window and delivery status; failures do not block other numbers',async()=>{
  const f=await fixture();
  try{
    const phones=['5534988748139','5534999999999','5511988887777','5511977776666'];
    await f.execute('update accounts set alerts_phones=$2 where id=$1',[f.source,JSON.stringify(phones)]);await f.conversation({assigned:true});
    for(const phone of phones.slice(2))await f.execute('insert into bridge_windows(account,phone,seen) values($1,$2,$3)',[f.sender,phone,f.now()]);
    const delivered=[];
    const worker=createWaitingAlerts({pool:f.pool,now:f.now,send:async(a,to,body)=>{assert.ok(body.includes('Atendente: Ana'));if(to===phones[2])throw Error('Timeout');delivered.push(to);return randomUUID();}});
    assert.deepEqual(await worker(),{attempted:4,sent:2,failed:2});
    assert.deepEqual(delivered.sort(),[phones[0],phones[3]].sort());
    const jobs=(await f.execute('select recipient,state,error from jobs')).rows;
    assert.equal(jobs.find(j=>j.recipient===phones[1]).state,'failed');assert.ok(jobs.find(j=>j.recipient===phones[1]).error.includes(phones[1]));
    assert.equal(jobs.find(j=>j.recipient===phones[2]).state,'uncertain');
    assert.deepEqual(await worker(),{attempted:0,sent:0,failed:0});
  }finally{await f.db.close();}
});

test('fan-out persists beyond one invocation, cancels removed recipients and never duplicates concurrent sends',async()=>{
  const f=await fixture();
  try{
    const phones=Array.from({length:8},(_,i)=>'551198888770'+i);
    await f.execute('update accounts set alerts_phones=$2 where id=$1',[f.source,JSON.stringify(phones)]);await f.conversation();
    for(const phone of phones)await f.execute('insert into bridge_windows(account,phone,seen) values($1,$2,$3)',[f.sender,phone,f.now()]);
    const result=await f.worker();assert.equal(result.sent,6);
    const pending=(await f.execute("select recipient from jobs where state='pending' order by id")).rows;assert.equal(pending.length,2);
    const retained=phones.filter(p=>p!==pending[0].recipient);await f.execute('update accounts set alerts_phones=$2 where id=$1',[f.source,JSON.stringify(retained)]);
    const next=await Promise.all([f.worker(),f.worker()]);assert.equal(next.reduce((s,r)=>s+r.sent,0),1);
    assert.equal(f.sent.length,7);assert.equal(new Set(f.sent.map(s=>s.to)).size,7);
    assert.equal((await f.execute("select state from jobs where recipient=$1",[pending[0].recipient])).rows[0].state,'cancelled');
    f.advance(5);assert.equal((await f.worker()).sent,6);
    await f.execute('update accounts set alerts_enabled=false where id=$1',[f.source]);assert.equal((await f.worker()).sent,0);
    assert.equal((await f.execute("select count(*) as n from jobs where state='pending'")).rows[0].n,0);
  }finally{await f.db.close();}
});

test('queued recipient alerts are cancelled when customers have already been answered',async()=>{
  const f=await fixture();
  try{
    const phones=Array.from({length:8},(_,i)=>'551198888770'+i);
    await f.execute('update accounts set alerts_phones=$2 where id=$1',[f.source,JSON.stringify(phones)]);const cid=await f.conversation();
    for(const phone of phones)await f.execute('insert into bridge_windows(account,phone,seen) values($1,$2,$3)',[f.sender,phone,f.now()]);
    assert.equal((await f.worker()).sent,6);await f.message(cid,'out','sent',0);
    assert.equal((await f.worker()).sent,0);
    assert.equal((await f.execute("select count(*) as n from jobs where state='cancelled'")).rows[0].n,2);
  }finally{await f.db.close();}
});

test('registered recipients renew their own window without creating customer conversations or gaining reply privileges',async()=>{
  const f=await fixture();
  try{
    await f.execute("update accounts set external='phone-id' where id=$1",[f.sender]);
    const phones=['5534999999999'];await f.execute('update accounts set alerts_phones=$2 where id=$1',[f.source,JSON.stringify(phones)]);
    const cid=await f.conversation();
    const handler=createInboundHandler({one:async(s,v)=>(await f.execute(s,v)).rows[0],run:f.execute,id:randomUUID,now:f.now,open:()=>({}),profile:async()=>({}),send:async()=>{throw Error('Must never reply to a customer');},queue:async()=>{},audit:async()=>{},alertRecipients:async a=>(await f.execute('select alerts_phones from accounts where tenant=$1 and bridge=$2',[a.tenant,a.id])).rows.flatMap(a=>a.alerts_phones)});
    const account=(await f.execute('select * from accounts where id=$1',[f.sender])).rows[0];
    const payload={entry:[{changes:[{value:{metadata:{phone_number_id:'phone-id'},messages:[{from:'5534999999999',id:'window-opening',timestamp:String(f.now()/1000),type:'text',text:{body:'Abrir janela'},context:{id:'unrelated-forward'}}]}}]}]};
    await handler(account,payload);
    assert.equal((await f.execute('select count(*) as n from conversations')).rows[0].n,1);
    assert.equal((await f.execute('select seen from bridge_windows where account=$1 and phone=$2',[f.sender,phones[0]])).rows[0].seen,f.now());
    assert.equal((await f.worker()).sent,1);assert.equal(f.sent[0].to,phones[0]);assert.ok(f.sent[0].body.includes('Maria'));
    assert.equal((await f.execute('select count(*) as n from messages where conversation=$1',[cid])).rows[0].n,1);
  }finally{await f.db.close();}
});

test('account API persists alerts and enforces administrator, tenant and scheduler authorization',async()=>{
  const f=await fixture();
  try {
    globalThis.__acquarellaPool=f.pool;
    const key=randomBytes(32);process.env.APP_ENCRYPTION_KEY=key.toString('base64');process.env.CRON_SECRET='test-cron-secret';
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(JSON.stringify({verifyToken:'test'})),cipher.final()]);
    await f.execute('update accounts set secret=$1',[Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64')]);
    const {default:app}=await import('../api/index.mjs');
    const admin=randomUUID();await f.execute("insert into users(id,tenant,name,email,hash,role) values($1,$2,'Admin','admin@test.invalid','unused','admin')",[admin,f.tenant]);
    for(const [session,user] of [['admin-session',admin],['agent-session',f.operator]])await f.execute('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(session).digest('hex'),user,Date.now()+60000]);
    const input={id:f.source,name:'Instagram',channel:'instagram',mode:'demo',bridge:f.sender,alertsEnabled:true,queueAlertMinutes:7,assignedAlertMinutes:22};
    const request=(data,session='admin-session')=>new Request('https://example.test/api/accounts',{method:'POST',headers:{'content-type':'application/json',cookie:`session=${session}`},body:JSON.stringify(data)});
    assert.equal((await app.fetch(request(input))).status,200);
    const account=(await f.execute('select * from accounts where id=$1',[f.source])).rows[0];assert.equal(account.alerts_enabled,true);assert.equal(account.queue_alert_minutes,7);assert.equal(account.assigned_alert_minutes,22);
    const alertRequest=(data,session='admin-session')=>new Request(`https://example.test/api/accounts/${f.source}/alerts`,{method:'POST',headers:{'content-type':'application/json',cookie:`session=${session}`},body:JSON.stringify(data)});
    const phoneInput=['+55 (34) 99999-9999','5534999999999','+55 11 98888-7777'];
    assert.equal((await app.fetch(alertRequest({alertsEnabled:true,alertPhones:phoneInput}))).status,200);
    assert.deepEqual((await f.execute('select alerts_phones from accounts where id=$1',[f.source])).rows[0].alerts_phones,['5534999999999','5511988887777']);
    assert.deepEqual((await f.execute('select alerts_phones from accounts where id=$1',[f.sender])).rows[0].alerts_phones,['5534988748139']);
    assert.equal((await app.fetch(alertRequest({alertsEnabled:true,alertPhones:[]}))).status,400);
    assert.equal((await app.fetch(alertRequest({alertsEnabled:true,alertPhones:['invalid']}))).status,400);
    assert.equal((await app.fetch(alertRequest({alertsEnabled:false,queueAlertMinutes:8,assignedAlertMinutes:12}))).status,200);
    assert.equal((await f.execute('select alerts_enabled from accounts where id=$1',[f.source])).rows[0].alerts_enabled,false);
    assert.equal((await app.fetch(alertRequest({alertsEnabled:true},'agent-session'))).status,403);
    const foreign=randomUUID();await f.execute("insert into accounts(id,tenant,name,channel,secret,mode) values($1,$2,'Foreign','whatsapp','unused','live')",[foreign,f.other]);
    assert.equal((await app.fetch(alertRequest({alertsEnabled:true,bridge:foreign}))).status,403);
    assert.equal((await app.fetch(request(input,'agent-session'))).status,403);
    assert.equal((await app.fetch(request({...input,queueAlertMinutes:0}))).status,400);
    assert.equal((await app.fetch(request({...input,bridge:''}))).status,400);
    assert.equal((await app.fetch(new Request('https://example.test/api/internal/waiting-alerts'))).status,401);
    assert.equal((await app.fetch(new Request('https://example.test/api/internal/waiting-alerts',{headers:{authorization:'Bearer test-cron-secret'}}))).status,200);
  }finally{delete globalThis.__acquarellaPool;await f.db.close();}
});
