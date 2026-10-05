import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const origin='https://acquarella-comunicacao.vercel.app';
for (const asset of ['index.html','app.js','crm.js','action-feedback.js','loading.css']) {
  const response=await fetch(origin+'/'+(asset==='index.html'?'':asset),{cache:'no-store'});
  assert.equal(response.status,200,asset);
  assert.equal(await response.text(),readFileSync('vercel-app/public/'+asset,'utf8'),asset+' differs from deployed version');
}
assert.equal((await (await fetch(origin+'/api/bootstrap')).json()).setup,false);
assert.equal((await fetch(origin+'/api/state')).status,401);
console.log('PASS production alias: all 5 updated assets match, bootstrap configured, anonymous state denied.');
