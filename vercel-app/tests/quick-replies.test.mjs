import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createQuickReplies} from '../lib/quick-replies.mjs';
import {quickReplyKey,quickReplyPreview,quickReplyText,quickReplyContactName,fillQuickReplyVariables} from '../public/quick-reply-format.mjs';

test('name variables use the current contact, replace repeated tokens once, and preserve the reusable template',()=>{
 const template='Olá, *{Nome}*! 😊\n{ nome }, podemos ajudar? {NOME} {Outra}';
 const crm={opportunities:[{conversation:'c',contact:'contact'}],contacts:[{id:'contact',name:'  Maria  da Silva '}]};
 const name=quickReplyContactName({id:'c',name:'Nome da conversa'},crm);assert.equal(name,'Maria da Silva');
 const text=fillQuickReplyVariables(quickReplyText(template,'whatsapp'),{name});assert.equal(text,'Olá, *Maria da Silva*! 😊\nMaria da Silva, podemos ajudar? Maria da Silva {Outra}');
 assert.equal(fillQuickReplyVariables(quickReplyText('*{Nome}*','instagram'),{name:'Ana_Silva'}),'Ana_Silva');
 assert.equal(fillQuickReplyVariables('{Nome}',{name:'Ana $& {Nome}'}),'Ana $& {Nome}');
 assert.equal(quickReplyContactName({id:'other',name:'Beatriz'},crm),'Beatriz');assert.equal(quickReplyContactName({id:'c',name:'Conversa'},{...crm,contacts:[{id:'contact',name:' '}]}),'Conversa');
 assert.equal(template,'Olá, *{Nome}*! 😊\n{ nome }, podemos ajudar? {NOME} {Outra}');
 assert.throws(()=>fillQuickReplyVariables('Olá {Nome}',{name:' '}),/Identifique o cliente/);assert.equal(fillQuickReplyVariables('Olá, tudo bem?'),'Olá, tudo bem?');
});
test('formatted responses preserve channel text and escape all markup',()=>{
 assert.equal(quickReplyKey('Promoção ÁXILA'),'promocao axila');
 const body='*Olá* _cliente_ ~antes~ `código` 😊\n- Item\n1. Segundo\n> Citação\n<script>alert(1)</script> https://exemplo.com/a_b';
 const html=quickReplyPreview(body);assert.match(html,/<strong>Olá<\/strong>/);assert.match(html,/<em>cliente<\/em>/);assert.match(html,/<s>antes<\/s>/);assert.match(html,/<code>código<\/code>/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/is-list/);assert.match(html,/is-quote/);
 assert.equal(quickReplyText(body,'whatsapp'),body);assert.match(quickReplyText(body,'instagram'),/^Olá cliente antes código 😊/);assert.match(quickReplyText(body,'messenger'),/https:\/\/exemplo.com\/a_b/);
});
test('tenant-scoped quick replies, permissions, version conflicts and reusable encrypted images',async()=>{
 const db=new PGlite(),tenant=randomUUID(),other=randomUUID(),uid=randomUUID(),oid=randomUUID();
 const query=async(sql,args=[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
 const pool={query,connect:async()=>({query,release(){}})};
 try{
  await db.exec('create table tenants(id uuid primary key);create table users(id uuid primary key);create table audit(id uuid primary key,tenant uuid,action text,created bigint);');
  await query('insert into tenants values($1),($2)',[tenant,other]);await query('insert into users values($1),($2)',[uid,oid]);
  await db.exec(await readFile(new URL('../supabase/migrations/202610240003_quick_replies.sql',import.meta.url),'utf8'));
  const app=createQuickReplies({pool,seal:v=>'sealed:'+Buffer.from(v).toString('base64'),open:v=>Buffer.from(v.slice(7),'base64').toString(),now:()=>1792870000000});
  const user={id:uid,tenant,name:'Ana',role:'admin'},foreign={id:oid,tenant:other,name:'Outra',role:'admin'},agent={...user,role:'agent'},viewer={...user,role:'viewer'},receptionist={...user,role:'receptionist'};
  const call=(path='',input,u=user,method=input?'POST':'GET')=>app.route(u,'/api/quick-replies'+path,method,input);
  const r=await call('',{name:'Boas-vindas',body:'*Olá!* 😊',asset:null});
  assert.equal((await call('',undefined,agent)).replies[0].body,'*Olá!* 😊');assert.equal((await call('',undefined,foreign)).replies.length,0);
  await assert.rejects(call('',undefined,viewer),{status:403});await assert.rejects(call('',{name:'X',body:'Y',asset:null},agent),{status:403});
  await assert.rejects(call('',{name:'BOAS-VINDAS',body:'Y',asset:null}),{status:409});
  await assert.rejects(call('',{id:r.id,version:1,name:'X',body:'Y',asset:null},foreign),{status:404});
  await call('',{id:r.id,version:1,name:'Boas-vindas',body:'Atualizada',asset:null},receptionist);
  await assert.rejects(call('',{id:r.id,version:1,name:'Nome',body:'Velha',asset:null}),{status:409});
  await assert.rejects(call('',{name:'Vazia',body:' ',asset:null}),{status:400});await assert.rejects(call('',{name:'Longa',body:'x'.repeat(1801),asset:null}),{status:400});
  await assert.rejects(call('/assets',{name:'x.svg',type:'image/svg+xml',size:10}),{status:400});await assert.rejects(call('/assets',{name:'x.png',type:'image/png',size:5242881}),{status:400});
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(256*1024)]),image=await call('/assets',{name:'publicidade.png',type:'image/png',size:bytes.length});
  await assert.rejects(call('/assets/'+image.id+'/finish',{}),{status:400});
  await assert.rejects(call('',{name:'Incompleta',body:'',asset:image.id}),{status:400});
  await assert.rejects(call('/assets/'+image.id+'/part',{part:0,data:bytes.subarray(0,image.chunkSize).toString('base64')},foreign),{status:404});
  await assert.rejects(call('/assets/'+image.id+'/part',{part:0,data:Buffer.alloc(image.chunkSize).toString('base64')}),{status:400});
  for(let i=0;i<2;i++)await call('/assets/'+image.id+'/part',{part:i,data:bytes.subarray(i*image.chunkSize,(i+1)*image.chunkSize).toString('base64')});
  await call('/assets/'+image.id+'/finish',{});
  const saved=await call('',{name:'Promoção',body:'',asset:image.id});
  const response=await call('/assets/'+image.id,undefined,agent);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  await assert.rejects(call('/assets/'+image.id,undefined,foreign),{status:404});
  await assert.rejects(call('/assets/'+image.id+'/discard',{}),{status:409});
  await assert.rejects(call('/assets/'+image.id+'/part',{part:0,data:bytes.subarray(0,image.chunkSize).toString('base64')}),{status:403});
  assert.ok((await query('select secret from quick_reply_parts')).rows.every(r=>r.secret.startsWith('sealed:')));
  await assert.rejects(call('/'+saved.id+'/delete',{version:1},agent),{status:403});await assert.rejects(call('/'+r.id+'/delete',{version:1}),{status:409});
  await call('/'+saved.id+'/delete',{version:1});assert.equal((await call()).replies.length,1);
  assert.equal((await query('select * from audit')).rows.length,4);
 }finally{await db.close();}
});
