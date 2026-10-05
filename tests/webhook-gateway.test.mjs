import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('Gateway publica webhooks e privacidade, preservando assinatura e bloqueando a central', async t => {
  const upstream = http.createServer((req, res) => {
    const parts = [];
    req.on('data', b => parts.push(b));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({path:req.url,method:req.method,signature:req.headers['x-hub-signature-256'],body:Buffer.concat(parts).toString(),cookie:req.headers.cookie}));
    });
  });
  await new Promise(resolve => upstream.listen(3201, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['scripts/webhook-gateway.mjs'], {
    env:{...process.env,PORT:'3201',WEBHOOK_PORT:'3202'},stdio:['ignore','pipe','pipe'],
  });
  t.after(async () => {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await stopped;
    await new Promise(resolve => upstream.close(resolve));
  });
  await new Promise((resolve,reject) => {child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Gateway encerrou')));});
  const base='http://127.0.0.1:3202';
  for(const path of ['/','/api/state','/api/setup','/data/secret.key','/webhooks/meta/../../api/state']) {
    assert.equal((await fetch(base+path)).status,404);
  }
  const path='/webhooks/meta/11111111-1111-1111-1111-111111111111';
  for (const [route, title] of [['/privacidade','Política de Privacidade'],['/exclusao-de-dados','Solicitar exclusão de dados']]) {
    const page=await fetch(base+route);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);assert.ok((await page.text()).includes(title));
    assert.equal((await fetch(base+route,{method:'POST',body:'test'})).status,405);
    const head=await fetch(base+route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }
  assert.equal((await fetch(base+'/privacy.css')).status,200);
  assert.equal((await fetch(base+path,{method:'DELETE'})).status,405);
  const raw=' { "entry": [], "texto": "Olá!" } ';
  const result=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256=test',Cookie:'private=test'},body:raw});
  const data=await result.json();
  assert.equal(data.body,raw);assert.equal(data.signature,'sha256=test');assert.equal(data.cookie,undefined);
  const challenge=await fetch(base+path+'?hub.challenge=test&hub.mode=subscribe');
  assert.equal((await challenge.json()).path,path+'?hub.challenge=test&hub.mode=subscribe');
  assert.equal((await fetch(base+path,{method:'POST',body:'x'.repeat(1048577)})).status,413);
});
