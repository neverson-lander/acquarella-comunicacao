import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const origin = 'https://acquarella-comunicacao.vercel.app';
const db = new DatabaseSync('data/central.sqlite', { readOnly: true });
const key = readFileSync('data/secret.key');
const checks = [];
const decrypt = value => {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
};
for (const a of db.prepare("select id,channel,secret from accounts where channel in ('instagram','messenger','whatsapp')").all()) {
  const secret = decrypt(a.secret);
  const url = new URL(`/webhooks/meta/${a.id}`, origin);
  url.searchParams.set('hub.mode', 'subscribe');
  url.searchParams.set('hub.verify_token', secret.verifyToken);
  url.searchParams.set('hub.challenge', 'production-verified');
  const verification = await fetch(url);
  assert.equal(verification.status, 200);
  assert.equal(await verification.text(), 'production-verified');
  const raw = JSON.stringify({ object: a.channel === 'messenger' ? 'page' : a.channel === 'whatsapp' ? 'whatsapp_business_account' : 'instagram', entry: [] });
  const endpoint = origin + url.pathname;
  const unsigned = await fetch(endpoint, { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 403);
  const signed = await fetch(endpoint, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret.appSecret).update(raw).digest('hex') } });
  assert.equal(signed.status, 200, `${a.channel}: webhook assinado recusado`);
  assert.equal((await signed.json()).received, true);
  checks.push({ channel: a.channel, challenge: true, rejectsUnsigned: true, acceptsSignedEmptyEvent: true });
}
for (const path of ['/', '/privacidade', '/exclusao-de-dados', '/style.css', '/app.js']) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200);
  checks.push({ path, status: response.status });
}
assert.equal((await (await fetch(origin + '/api/bootstrap')).json()).setup, false);
assert.equal((await fetch(origin + '/api/state')).status, 401);
db.close();
console.log(JSON.stringify({ origin, checks, administratorConfigured: true, anonymousDataBlocked: true }));
