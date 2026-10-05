import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const db = new DatabaseSync('data/central.sqlite', { readOnly: true });
const key = readFileSync('data/secret.key');
function decrypt(value) {
  const b = Buffer.from(value, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]));
}
async function graph(path, token) {
  const response = await fetch(`https://graph.facebook.com/v26.0/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  return response.ok ? body : { status: response.status, code: body.error?.code, message: body.error?.message };
}
try {
  for (const a of db.prepare('select * from accounts').all()) {
    const s = decrypt(a.secret);
    console.log(JSON.stringify({ channel: a.channel, name: a.name, external: a.external, mode: a.mode }));
    if (a.channel === 'messenger' && s.token) {
      console.log(JSON.stringify({ page: await graph(`${a.external}?fields=id,name`, s.token) }));
      console.log(JSON.stringify({ pageSubscriptions: await graph(`${a.external}/subscribed_apps?fields=id,name,subscribed_fields`, s.token) }));
      console.log(JSON.stringify({ appSubscriptions: await graph('1062549136589562/subscriptions', `1062549136589562|${s.appSecret}`) }));
      const raw = JSON.stringify({ object: 'page', entry: [] });
      const response = await fetch(`https://acquarella-comunicacao.vercel.app/webhooks/meta/${a.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', s.appSecret).update(raw).digest('hex') }, body: raw,
        signal: AbortSignal.timeout(20000),
      });
      console.log(JSON.stringify({ messengerSignedEmptyWebhook: response.status }));
    }
    if (a.channel === 'whatsapp' && s.token) console.log(JSON.stringify({ phone: await graph(`${a.external}?fields=id,display_phone_number,verified_name`, s.token) }));
  }
} finally { db.close(); }
