import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID,generateKeyPairSync,sign,randomBytes,createHash,createCipheriv} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createAttendance} from '../lib/attendance-store.mjs';
import {createChatgptConnection,verifyIdentity} from '../lib/chatgpt-connection.mjs';
import {createEvaluationWorker,readEvaluationStream} from '../lib/attendance-evaluations.mjs';
import {criteria,validateEvaluation} from '../lib/evaluation-domain.mjs';
import {evaluationMarkup,evaluationMetrics,matchesEvaluationScore} from '../public/evaluations.js';

const db=new PGlite();let stamp=1792760400000,pending=Promise.resolve();
const now=()=>stamp;
async function query(sql,args=[]){const r=await db.query(sql,args);for(const f of r.fields||[])if(f.dataTypeID===20)for(const row of r.rows)if(row[f.name]!==null)row[f.name]=Number(row[f.name]);return {...r,rowCount:r.affectedRows??r.rows.length};}
const pool={query,connect:async()=>{const previous=pending;let release;pending=new Promise(r=>release=r);await previous;return{query,release};}};
before(async()=>{for(const name of (await readdir(new URL('../supabase/migrations/',import.meta.url))).sort()){await db.exec((await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;',''));}});
after(()=>db.close());
const permitted=(u,a)=>u.tenant===a.tenant&&(u.role==='admin'||u.accounts.includes(a.id));
async function fixture(enabled=true){
  stamp+=10000;const tenant=randomUUID(),account=randomUUID(),cid=randomUUID(),uid=randomUUID();
  await query("insert into tenants(id,name,phone) values($1,'Acquarella','5511999999999')",[tenant]);
  await query("insert into accounts(id,tenant,name,channel,secret,mode,evaluation_enabled) values($1,$2,'WhatsApp','whatsapp','{}','live',$3)",[account,tenant,enabled]);
  await query("insert into users(id,tenant,name,email,hash,role,accounts) values($1,$2,'Ana',$3,'unused','agent',$4)",[uid,tenant,uid+'@test.invalid',JSON.stringify([account])]);
  await query("insert into conversations(id,tenant,account,customer,name,status,updated,last_inbound) values($1,$2,$3,'customer','Cliente','open',$4,$4)",[cid,tenant,account,stamp]);
  const user={id:uid,tenant,name:'Ana',role:'agent',accounts:[account]},attendance=createAttendance({pool,permitted,now});
  await attendance.claim(user,cid);
  const ids=[randomUUID(),randomUUID()];
  await query("insert into messages(id,conversation,direction,body,created,state,operator_id,operator_name) values($1,$2,'in','Quero agendar manicure',$3,'received',null,null),($4,$2,'out','Posso consultar os horários para você?',$3,'sent',$5,'Ana')",[ids[0],cid,stamp,ids[1],uid]);
  const close=()=>attendance.status(user,cid,'resolved',{source:'organic',had_scheduling:false});
  const job=async()=>(await query('select * from attendance_evaluations where conversation=$1 order by created desc',[cid])).rows[0];
  return {tenant,account,cid,user,attendance,ids,close,job};
}
const resultFor=snapshot=>({type:'commercial',summary:'Boa condução.',strengths:['Clareza'],improvements:['Oferecer opções após consultar a agenda'],limitations:[],suggested_reply:'Vou consultar as opções para você.',criteria:Object.fromEntries(criteria.map(([k])=>[k,{score:k==='objections'?null:8,reason:k==='objections'?'Não houve objeção.':'Boa condução.',evidence_ids:k==='objections'?[]:[snapshot.messages[0].id]}]))});
const stream=value=>new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
async function isolate(){await query("update attendance_evaluations set state='cancelled' where state in ('pending','waiting','processing')");}
async function connected(f,model='available-model'){
  await query("insert into ai_connections(tenant,host_id,client_id,subject,email,credentials,model,state,updated) values($1,$2,'oaiapp_test','sub','user@test.invalid',$3,$4,'connected',$5) on conflict(tenant) do update set credentials=excluded.credentials,model=excluded.model,state='connected'",[f.tenant,'urn:uuid:'+randomUUID(),JSON.stringify({access_token:'fake-test-token',refresh_token:'fake-refresh',expires_at:stamp+3600000,scopes:['chatgpt.tokens.use.direct']}),model,stamp]);
}
test('channel opt-in, atomic closure, immutable cycle snapshots and separate reopenings',async()=>{
  const disabled=await fixture(false);await disabled.close();assert.equal(await disabled.job(),undefined);
  const f=await fixture();await assert.rejects(f.attendance.status(f.user,f.cid,'resolved',{had_scheduling:false,source:'invalid'}));assert.equal(await f.job(),undefined);
  await f.close();const first=await f.job();assert.equal(first.state,'pending');assert.equal(first.snapshot.messages.length,2);
  await assert.rejects(f.close(),e=>e.status===409);assert.equal((await query('select count(*) as n from attendance_evaluations where conversation=$1',[f.cid])).rows[0].n,1);
  stamp+=1000;await f.attendance.status(f.user,f.cid,'open');
  await query("insert into messages(id,conversation,direction,body,created,state) values($1,$2,'in','Outra solicitação',$3,'received')",[randomUUID(),f.cid,stamp]);
  stamp+=1000;await query("insert into messages(id,conversation,direction,body,created,state,operator_id) values($1,$2,'out','Vou verificar',$3,'sent',$4)",[randomUUID(),f.cid,stamp,f.user.id]);await f.close();
  const second=await f.job();assert.notEqual(first.id,second.id);assert.equal(second.snapshot.messages.length,2);assert.ok(second.snapshot.messages.every(m=>!f.ids.includes(m.id)));
  assert.deepEqual((await query('select snapshot from attendance_evaluations where id=$1',[first.id])).rows[0].snapshot,first.snapshot);
  const foreign=await fixture();await assert.rejects(f.attendance.status(foreign.user,f.cid,'open'),e=>e.status===404);
});
test('worker validates evidence, persists weighted notes, uses streaming and avoids concurrent duplicate requests',async()=>{
  await isolate();const f=await fixture();await connected(f);await f.close();const job=await f.job();let calls=0;
  const worker=createEvaluationWorker({pool,connection:{access:async()=>({token:'fake',model:'available-model'})},now,fetcher:async(url,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(body.store,false);assert.equal(body.stream,true);assert.ok(!('background'in body));assert.ok(Array.isArray(body.input));assert.equal(body.text.format.strict,true);return stream(resultFor(job.snapshot));}});
  await Promise.all([worker(),worker()]);const saved=await f.job();assert.equal(calls,1);assert.equal(saved.state,'completed');assert.equal(Number(saved.score),8);assert.equal(saved.result.criteria.objections.score,null);
  const forged=resultFor(job.snapshot);forged.criteria.clarity.evidence_ids=['invented'];assert.throws(()=>validateEvaluation(forged,job.snapshot));
  const bad=resultFor(job.snapshot);bad.criteria.clarity.score=11;assert.throws(()=>validateEvaluation(bad,job.snapshot));
});
test('usage errors, missing connection, retry backoff and expired lease recovery remain asynchronous',async()=>{
  await isolate();const f=await fixture();await f.close();
  const missing=createEvaluationWorker({pool,now,connection:{access:async()=>{throw Object.assign(Error(),{status:401});}}});await missing();assert.equal((await f.job()).state,'waiting');assert.equal((await f.job()).attempts,0);
  stamp+=300001;
  const limited=createEvaluationWorker({pool,now,connection:{access:async()=>({token:'fake',model:'available-model'})},fetcher:async()=>new Response('data: '+JSON.stringify({type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}})+'\n\n')});await limited();let saved=await f.job();assert.equal(saved.state,'waiting');assert.equal(saved.next_attempt,stamp+1800000);assert.equal(saved.attempts,0);
  const retry=createEvaluationWorker({pool,now,connection:{access:async()=>({token:'fake',model:'available-model'})},fetcher:async()=>{throw Error('secret must not reach UI');}});
  stamp+=1800001;await retry();assert.equal((await f.job()).attempts,1);await retry();assert.equal((await f.job()).attempts,1);
  stamp+=60001;await retry();stamp+=120001;await retry();saved=await f.job();assert.equal(saved.state,'failed');assert.equal(saved.attempts,3);assert.ok(!saved.error.includes('secret'));
  await query("update attendance_evaluations set state='processing',next_attempt=$1,attempts=0 where id=$2",[stamp-1,saved.id]);await retry();assert.equal((await f.job()).state,'pending');
});
test('disabled channels cancel pending evaluation and incomplete streams never produce a grade',async()=>{
  await isolate();const f=await fixture();await f.close();await query('update accounts set evaluation_enabled=false where id=$1',[f.account]);let calls=0;
  await createEvaluationWorker({pool,now,connection:{access:async()=>{calls++;}}})();assert.equal((await f.job()).state,'cancelled');assert.equal(calls,0);
  await assert.rejects(readEvaluationStream(new Response('data: {"type":"response.output_text.delta","delta":"{\\\"score\\\":10}"}\n\n')),/antes de concluir/);
  const empty=await fixture();await query("delete from messages where conversation=$1 and direction='out'",[empty.cid]);await empty.close();assert.equal((await empty.job()).state,'skipped');
});
test('ChatGPT store:false streams retain output even when the completed response omits it',async()=>{
  const value={example:'Acentuação correta: avaliação'},text=JSON.stringify(value);
  const events=[{type:'response.output_text.delta',output_index:0,content_index:0,delta:text.slice(0,12)},{type:'response.output_text.delta',output_index:0,content_index:0,delta:text.slice(12)},{type:'response.output_text.done',output_index:0,content_index:0,text},{type:'response.completed',response:{output:[]}}];
  const raw=events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('');
  const bytes=new TextEncoder().encode(raw);const body=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}});
  assert.deepEqual(await readEvaluationStream(new Response(body)),value);
});
test('OAuth pairings expire, are single use, isolate tenants and keep credentials out of status',async()=>{
  const f=await fixture(),g=await fixture(),connection=createChatgptConnection({pool,seal:JSON.stringify,open:JSON.parse,now,verifyToken:async(token,{nonce,clientId})=>{assert.equal(nonce,'n'.repeat(43));assert.equal(clientId,'oaiapp_test');return{sub:'sub',email:'user@test.invalid'};}});
  const pair=await connection.pair(f.tenant);await assert.rejects(connection.begin({token:'invalid',nonce:'n'.repeat(43)}));
  const begin=await connection.begin({token:pair.token,nonce:'n'.repeat(43)});assert.equal(begin.client_id,'dynamic_agent_client');await assert.rejects(connection.begin({token:pair.token,nonce:'n'.repeat(43)}));
  const input={token:pair.token,client_id:'oaiapp_test',tokens:{token_type:'Bearer',access_token:'fake-access',refresh_token:'fake-refresh',id_token:'fake-id',expires_in:3600,scope:'openid chatgpt.tokens.use.direct'}};
  await connection.complete(input);await assert.rejects(connection.complete(input));
  const status=await connection.status(f.tenant);assert.equal(status.state,'connected');assert.equal(status.email,'user@test.invalid');assert.ok(!JSON.stringify(status).includes('fake-'));assert.equal((await connection.status(g.tenant)).state,'disconnected');
  const next=await connection.pair(f.tenant);const host=await connection.begin({token:next.token,nonce:'n'.repeat(43)});assert.equal(host.host_id,begin.host_id);assert.equal(host.client_id,'oaiapp_test');
  stamp+=600001;await assert.rejects(connection.complete({...input,token:next.token}),e=>e.status===401);
});
test('rotating OAuth refresh is serialized and preserves the latest renewable token',async()=>{
  const f=await fixture();await connected(f);await query('update ai_connections set credentials=$1 where tenant=$2',[JSON.stringify({access_token:'expired',refresh_token:'old-refresh',expires_at:stamp-1,scopes:['chatgpt.tokens.use.direct']}),f.tenant]);let calls=0;
  const connection=createChatgptConnection({pool,seal:JSON.stringify,open:JSON.parse,now,fetcher:async(url,options)=>{calls++;assert.equal(options.body.get('refresh_token'),'old-refresh');assert.equal(options.body.has('scope'),false);return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});}});
  const [a,b]=await Promise.all([connection.access(f.tenant),connection.access(f.tenant)]);assert.equal(calls,1);assert.equal(a.token,'new-access');assert.equal(b.token,'new-access');
  assert.equal(JSON.parse((await query('select credentials from ai_connections where tenant=$1',[f.tenant])).rows[0].credentials).refresh_token,'new-refresh');
});
test('OIDC verifies signature, nonce, audience, expiry and fixed issuer',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'test',use:'sig'};
  const fetcher=async url=>String(url).includes('openid-configuration')?Response.json({issuer:'https://auth.openai.com',jwks_uri:'https://auth.openai.com/jwks'}):Response.json({keys:[jwk]});
  const jwt=claims=>{const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'),body=Buffer.from(JSON.stringify(claims)).toString('base64url');return header+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+body),privateKey).toString('base64url');};
  const claims={iss:'https://auth.openai.com',sub:'user',aud:'client',nonce:'nonce',exp:stamp/1000+3600},options={clientId:'client',nonce:'nonce',now,fetcher};
  assert.equal((await verifyIdentity(jwt(claims),options)).sub,'user');
  for(const change of [{nonce:'other'},{aud:'other'},{iss:'https://evil.invalid'},{exp:stamp/1000-1}])await assert.rejects(verifyIdentity(jwt({...claims,...change}),options));
  const forged=jwt(claims).split('.');forged[1]=Buffer.from(JSON.stringify({...claims,sub:'attacker'})).toString('base64url');await assert.rejects(verifyIdentity(forged.join('.'),options));
});
test('rendered reports escape model text, show verifiable message links and filter monthly means',()=>{
  const escape=v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const snapshot={messages:[{id:'msg'}]},result=validateEvaluation(resultFor(snapshot),snapshot);result.summary='<script>alert(1)</script>';
  const e={id:'eval',closure:'closure',owner:'u',owner_name:'Ana',state:'completed',score:8,rubric:'sales-v1',result,created:stamp};
  const markup=evaluationMarkup(e,escape);assert.ok(!markup.includes('<script>'));assert.match(markup,/data-evaluation-message="msg"/);assert.match(markup,/Não aplicável/);
  const state={accounts:[{id:'a',channel:'whatsapp',mode:'live'}],conversations:[{account:'a',assigned_to:'u',evaluations:[e]}]};assert.match(evaluationMetrics(state,{channel:'whatsapp'},escape),/8.0\/10/);assert.ok(!evaluationMetrics(state,{channel:'instagram'},escape).includes('8.0/10'));
});

test('completed analyses without a grade remain visible and do not appear as absent or enter averages',()=>{
  const esc=v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const e={id:'analysis-without-grade',owner:'u',owner_name:'Ana',state:'completed',score:null,rubric:'sales-v1',created:stamp,result:{type:'insufficient',summary:'Conversa interna; contexto insuficiente para dar uma nota.'}};
  const state={accounts:[{id:'a',channel:'whatsapp',name:'Neverson',mode:'live'}],conversations:[{id:'c',name:'Contato avaliado',account:'a',assigned_to:'u',evaluations:[e]}]};
  const html=evaluationMetrics(state,{},esc);
  assert.match(html,/Contato avaliado/);assert.match(html,/Analisado · sem nota/);assert.match(html,/Conversa interna; contexto insuficiente/);assert.match(html,/data-open-evaluation="analysis-without-grade"/);
  assert.match(html,/Ainda não há avaliações com nota/);assert.ok(!html.includes('Ainda não há avaliações concluídas'));
  assert.ok(!evaluationMetrics(state,{channel:'instagram'},esc).includes('analysis-without-grade'));
});

test('score filters respect boundary values and never treat ungraded or pending work as zero',()=>{
  const e=score=>({state:'completed',score});
  for(const score of [0,4.9])assert.equal(matchesEvaluationScore(e(score),'below5'),true);
  assert.equal(matchesEvaluationScore(e(5),'below5'),false);
  for(const score of [5,'6.9'])assert.equal(matchesEvaluationScore(e(score),'5to7'),true);
  assert.equal(matchesEvaluationScore(e(7),'5to7'),false);
  for(const score of [7,8.9])assert.equal(matchesEvaluationScore(e(score),'7to9'),true);
  assert.equal(matchesEvaluationScore(e(9),'7to9'),false);
  for(const score of [9,10])assert.equal(matchesEvaluationScore(e(score),'9plus'),true);
  assert.equal(matchesEvaluationScore(e(null),'ungraded'),true);
  for(const filter of ['graded','below5','5to7','7to9','9plus'])assert.equal(matchesEvaluationScore(e(null),filter),false);
  for(const state of ['pending','processing','waiting','failed','skipped'])assert.equal(matchesEvaluationScore({state,score:null},'ungraded'),false);
  assert.equal(matchesEvaluationScore({state:'pending',score:null},'all'),true);
});

test('a score selection filters report rows and monthly averages together with channel and period',()=>{
  const esc=v=>String(v??'');
  const evaluations=[{id:'low',score:4.9},{id:'middle',score:6},{id:'good',score:8},{id:'excellent',score:10},{id:'no-grade',score:null}].map(e=>({...e,state:'completed',created:stamp,owner:'u',owner_name:'Ana',rubric:'sales-v1',result:{summary:e.id}}));
  const state={accounts:[{id:'a',name:'WhatsApp',mode:'live',channel:'whatsapp'}],conversations:[{id:'c',name:'Cliente',assigned_to:'u',account:'a',evaluations}]};
  const html=evaluationMetrics(state,{evaluationScore:'7to9',channel:'whatsapp',owner:'u'},esc);
  assert.match(html,/data-open-evaluation="good"/);assert.match(html,/8.0\/10/);
  for(const id of ['low','middle','excellent','no-grade'])assert.ok(!html.includes('data-open-evaluation="'+id+'"'));
  assert.ok(!evaluationMetrics(state,{evaluationScore:'graded',from:'2099-01-01'},esc).includes('data-open-evaluation='));
  const ungraded=evaluationMetrics(state,{evaluationScore:'ungraded'},esc);assert.match(ungraded,/data-open-evaluation="no-grade"/);assert.ok(!ungraded.includes('data-open-evaluation="good"'));
});

test('HTTP permissions protect settings and snapshots; channel changes cancel the queue and receipts stay tenant-scoped',async()=>{
  await isolate();const f=await fixture(),foreign=await fixture();await f.close();const job=await f.job();
  const key=randomBytes(32);process.env.APP_ENCRYPTION_KEY=key.toString('base64');globalThis.__acquarellaPool=pool;
  const seal=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');};
  await query('update accounts set secret=$1 where id=any($2::uuid[])',[seal({transport:'meta'}),[f.account,foreign.account]]);
  const app=(await import('../api/index.mjs')).default;
  const sessions=[];
  for(const user of [f.user,foreign.user]){const token=randomBytes(32).toString('hex');await query('insert into sessions(id,"user",expires) values($1,$2,$3)',[createHash('sha256').update(token).digest('hex'),user.id,Date.now()+60000]);sessions.push(token);}
  const request=(path,body,token=sessions[0])=>app.fetch(new Request('https://central.test/api/'+path,{method:body?'POST':'GET',headers:{cookie:'session='+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
  assert.equal((await request('ai/status')).status,403);
  assert.equal((await request('accounts/'+f.account+'/evaluation',{enabled:false})).status,403);
  const agentState=await (await request('state')).json();assert.equal(agentState.conversations[0].evaluations[0].id,job.id);assert.ok(!JSON.stringify(agentState.conversations[0].evaluations).includes('snapshot'));
  await query("update users set role='admin' where id=any($1::uuid[])",[[f.user.id,foreign.user.id]]);
  assert.equal((await request('accounts/'+f.account+'/evaluation',{enabled:false},sessions[1])).status,403);
  assert.equal((await request('evaluations/'+job.id+'/retry',{},sessions[1])).status,404);
  assert.equal((await request('accounts/'+f.account+'/evaluation',{enabled:'yes'})).status,400);
  assert.equal((await request('accounts/'+f.account+'/evaluation',{enabled:false})).status,200);assert.equal((await f.job()).state,'cancelled');
  const pair=await (await request('ai/pair',{})).json();assert.equal(pair.token.length,43);assert.equal((await request('ai/status')).status,200);
  const adminState=await (await request('state')).json();assert.ok(!JSON.stringify(adminState).includes(pair.token));assert.ok(!JSON.stringify(adminState).includes('token_hash'));
  assert.equal((await app.fetch(new Request('https://central.test/api/internal/attendance-evaluations'))).status,401);
});
