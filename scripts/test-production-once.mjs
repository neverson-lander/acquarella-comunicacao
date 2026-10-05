import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv,createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
const origin='https://acquarella-comunicacao.neversonrl.chatgpt.site',key=readFileSync('data/secret.key'),db=new DatabaseSync('data/central.sqlite');
const decrypt=value=>{const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());};
const accounts=db.prepare("SELECT id,channel,secret FROM accounts WHERE channel IN ('instagram','messenger')").all();
const checks=[];
for(const a of accounts){const s=decrypt(a.secret),challenge='verified-'+a.channel;const u=new URL(`${origin}/webhooks/meta/${a.id}`);u.searchParams.set('hub.mode','subscribe');u.searchParams.set('hub.verify_token',s.verifyToken);u.searchParams.set('hub.challenge',challenge);const get=await fetch(u);checks.push({route:a.channel,verify:get.status,challenge:(await get.text())===challenge});}
const messenger=accounts.find(a=>a.channel==='messenger'),secret=decrypt(messenger.secret),raw=JSON.stringify({object:'page',entry:[]}),signature='sha256='+createHmac('sha256',secret.appSecret).update(raw).digest('hex');const post=await fetch(`${origin}/webhooks/meta/${messenger.id}`,{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':signature},body:raw});checks.push({route:'messenger-post',status:post.status,accepted:post.ok});
console.log(JSON.stringify(checks));db.close();
