import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('Autenticação, isolamento multi-tenant, RBAC, credenciais e webhooks',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'acquarella-test-'));
 const child=spawn(process.execPath,['--import','./tests/meta-mock.mjs','server.mjs'],{env:{...process.env,DATA_DIR:dir,PORT:'3199',HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 t.after(async()=>{child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});});
 for(let i=0;i<80&&!logs.includes('disponível');i++)await new Promise(r=>setTimeout(r,100));assert.match(logs,/disponível/);
 const url='http://127.0.0.1:3199';
 async function req(path,body,cookie=''){const r=await fetch(url+'/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:cookie},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 await t.test('Primeiro acesso sem senha padrão e sessão protegida',async()=>{
 assert.equal((await req('state')).status,401);assert.equal((await req('bootstrap')).data.setup,true);
 assert.equal((await req('setup',{company:'Acquarella',name:'Admin',email:'admin@example.com',password:'short'})).status,400);
 assert.equal((await req('setup',{company:'Acquarella',name:'Admin',email:'admin@example.com',password:'TesteSeguro123!'})).status,201);
 assert.equal((await req('setup',{})).status,409);
 });
 const admin=(await req('login',{email:'admin@example.com',password:'TesteSeguro123!'})).cookie;
 const state=(await req('state',null,admin)).data;const ig=state.accounts.find(a=>a.channel==='instagram');const fb=state.accounts.find(a=>a.channel==='messenger');const wa=state.accounts.find(a=>a.channel==='whatsapp');
 await t.test('Demonstração responde sem enfileirar envios reais',async()=>{const c=state.conversations.find(c=>c.account===ig.id);assert.equal((await req(`conversations/${c.id}/reply`,{body:'Resposta de teste'},admin)).status,200);const s=(await req('state',null,admin)).data;assert.equal(s.conversations.find(x=>x.id===c.id).messages.at(-1).state,'simulated');assert.equal(s.jobs.length,0);});
 await t.test('Atendente só acessa contas permitidas; visualizador não responde',async()=>{
 assert.equal((await req('users',{name:'Agente',email:'agent@example.com',password:'TesteSeguro123!',role:'agent',accounts:[ig.id]},admin)).status,200);
 const agent=(await req('login',{email:'agent@example.com',password:'TesteSeguro123!'})).cookie;const s=(await req('state',null,agent)).data;assert.equal(s.accounts.length,1);assert.equal(s.accounts[0].verifyToken,undefined);
 assert.equal((await req(`conversations/${state.conversations.find(c=>c.account===fb.id).id}/reply`,{body:'Bloquear'},agent)).status,403);
 assert.equal((await req('accounts',{name:'Hack',channel:'instagram'},agent)).status,403);
 await req('users',{name:'Leitor',email:'viewer@example.com',password:'TesteSeguro123!',role:'viewer',accounts:[ig.id]},admin);
 const viewer=(await req('login',{email:'viewer@example.com',password:'TesteSeguro123!'})).cookie;
 assert.equal((await req(`conversations/${s.conversations[0].id}/reply`,{body:'Bloquear'},viewer)).status,403);
 });
 await t.test('Empresas têm dados e permissões isolados',async()=>{
 assert.equal((await req('tenants',{name:'Outra empresa',phone:'5511999999999',adminName:'Admin 2',email:'other@example.com',password:'TesteSeguro123!'},admin)).status,201);
 const other=(await req('login',{email:'other@example.com',password:'TesteSeguro123!'})).cookie;const s=(await req('state',null,other)).data;
 assert.equal(s.accounts.length,0);assert.equal(s.conversations.length,0);assert.equal(s.users.length,1);
 assert.equal((await req('accounts',{id:ig.id,name:'Intrusão'},other)).status,403);
 assert.equal((await req(`conversations/${state.conversations[0].id}/reply`,{body:'Intrusão'},other)).status,404);
 assert.equal((await req('users',{name:'Outro',email:'x@example.com',password:'TesteSeguro123!',role:'agent',accounts:[ig.id]},other)).status,403);
 });
 await t.test('Webhooks assinados persistem, deduplicam e registram falta de ponte',async()=>{
 const token='credential-never-exposed';const appSecret='test-app-secret';
 assert.equal((await req('accounts',{id:ig.id,name:ig.name,channel:'instagram',mode:'live',external:'123456',token,appSecret,version:'v25.0',bridge:wa.id},admin)).status,200);
 const s=(await req('state',null,admin)).data;assert.ok(!JSON.stringify(s).includes(token));assert.ok(!JSON.stringify(s).includes(appSecret));
 const db=new DatabaseSync(join(dir,'central.sqlite'));assert.ok(!db.prepare('SELECT secret FROM accounts WHERE id=?').get(ig.id).secret.includes(token));db.close();
 const endpoint=url+ig.webhook;
 assert.equal((await fetch(endpoint+'?hub.mode=subscribe&hub.verify_token='+ig.verifyToken+'&hub.challenge=ok')).status,200);
 assert.equal((await fetch(endpoint+'?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ok')).status,403);
 const payload=JSON.stringify({entry:[{id:'123456',messaging:[{sender:{id:'998877'},timestamp:Date.now(),message:{mid:'unique-message',text:'Mensagem real de webhook'}}]}]});
 assert.equal((await fetch(endpoint,{method:'POST',body:payload})).status,403);
 const headers={'x-hub-signature-256':'sha256='+createHmac('sha256',appSecret).update(payload).digest('hex')};
 for(let i=0;i<2;i++)assert.equal((await fetch(endpoint,{method:'POST',headers,body:payload})).status,200);
 await new Promise(r=>setTimeout(r,1300));const final=(await req('state',null,admin)).data;const c=final.conversations.find(c=>c.customer==='998877');assert.ok(c);assert.equal(c.messages.length,1);assert.ok(final.audit.some(a=>a.action.includes('ponte')));
 });
 await t.test('Aceita envelope changes, normaliza segundos e ignora ativos alheios',async()=>{
 const value={sender:{id:'334455'},recipient:{id:'123456'},timestamp:Math.floor(Date.now()/1000),message:{mid:'changes-mid',text:'Teste de envelope changes'}};
 const signed=async(payload)=>{const raw=JSON.stringify(payload);return fetch(url+ig.webhook,{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','test-app-secret').update(raw).digest('hex')},body:raw});};
 await signed({entry:[{id:'999999',changes:[{field:'messages',value:{...value,sender:{id:'unauthorized'}}}]}]});
 await signed({entry:[{id:'0',changes:[{field:'messages',value:{...value,sender:{id:'synthetic'}}}]}]});
 await signed({entry:[{id:'123456',changes:[{field:'messages',value}]}]});
 await signed({entry:[{id:'123456',messaging:[value]}]});
 await new Promise(r=>setTimeout(r,1100));
 const s=(await req('state',null,admin)).data,c=s.conversations.find(c=>c.customer==='334455');assert.ok(c);assert.equal(c.messages.length,1);assert.equal(c.last_inbound,value.timestamp*1000);assert.ok(!s.conversations.some(c=>['unauthorized','synthetic'].includes(c.customer)));
 });
 await t.test('Encaminha à equipe e devolve resposta citada ao cliente correto (Meta simulada)',async()=>{
 const appSecret='test-app-secret';await req('accounts',{id:wa.id,name:wa.name,channel:'whatsapp',mode:'live',external:'777888',token:'test-token',appSecret},admin);
 const signed=async(account,payload)=>{const raw=JSON.stringify(payload);const r=await fetch(url+account.webhook,{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',appSecret).update(raw).digest('hex')},body:raw});assert.equal(r.status,200);};
 const whatsapp=messages=>({entry:[{changes:[{value:{metadata:{phone_number_id:'777888'},messages}}]}]});
 await signed(wa,whatsapp([{id:'open-window',from:'5534988748139',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Olá'}}]));
 await new Promise(r=>setTimeout(r,1100));
 await signed(ig,{entry:[{id:'123456',messaging:[{sender:{id:'998877'},timestamp:Date.now(),message:{mid:'forward-this-message',text:'Preciso de atendimento'}}]}]});
 await new Promise(r=>setTimeout(r,1100));
 let calls=readFileSync(join(dir,'meta-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);assert.equal(calls[0].body.to,'5534988748139');assert.ok(calls[0].body.text.body.includes('Preciso de atendimento'));
 const reply={id:'wa-response-1',from:'5534988748139',timestamp:String(Math.floor(Date.now()/1000)),text:{body:'Claro! Como podemos ajudar?'},context:{id:calls[0].id}};
 await signed(wa,whatsapp([{...reply,id:'attacker-response',from:'5511888888888'}]));
 await signed(wa,whatsapp([reply]));await new Promise(r=>setTimeout(r,1100));
 await signed(wa,{...whatsapp([reply]),extra:'different-batch'});await new Promise(r=>setTimeout(r,1100));
 calls=readFileSync(join(dir,'meta-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.length,2);assert.equal(calls[1].body.recipient.id,'998877');assert.equal(calls[1].body.message.text,'Claro! Como podemos ajudar?');assert.ok(calls[1].url.includes('graph.instagram.com'));
 const s=(await req('state',null,admin)).data;assert.equal(s.conversations.find(c=>c.customer==='998877').messages.filter(m=>m.direction==='out').length,1);
 const db=new DatabaseSync(join(dir,'central.sqlite'));db.prepare('UPDATE conversations SET last_inbound=? WHERE customer=?').run(Date.now()-90000000,'998877');db.close();
 const c=s.conversations.find(c=>c.customer==='998877');assert.equal((await req(`conversations/${c.id}/reply`,{body:'Fora da janela'},admin)).status,400);
 });
 await t.test('Bloqueia origem externa e encerra sessão',async()=>{const r=await fetch(url+'/api/tenant',{method:'POST',headers:{Origin:'https://attacker.example','Content-Type':'application/json',Cookie:admin},body:JSON.stringify({name:'Ataque',phone:'5511111111111'})});assert.equal(r.status,403);await req('logout',{},admin);assert.equal((await req('state',null,admin)).status,401);});
});
