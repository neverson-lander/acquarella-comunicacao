import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const accountId = '7b4a8a24-5bd9-4e57-bf2e-38871f3a18e7';
const key = readFileSync(resolve('data', 'secret.key'));
const db = new DatabaseSync(resolve('data', 'central.sqlite'), { readOnly: true });
const row = db.prepare('SELECT id,name,channel,external,secret,mode FROM accounts WHERE id=?').get(accountId);
const b = Buffer.from(row.secret, 'base64');
const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
d.setAuthTag(b.subarray(12, 28));
const secret = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
const challenge = 'messenger-ok';
const response = await fetch(`http://127.0.0.1:3000/webhooks/meta/${accountId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(secret.verifyToken)}&hub.challenge=${challenge}`);
const body = await response.text();
console.log(JSON.stringify({
  account: { id: row.id, name: row.name, channel: row.channel, external: row.external, mode: row.mode },
  credentialsEncryptedAtRest: !row.secret.includes(secret.token) && !row.secret.includes(secret.appSecret),
  tokenConfigured: Boolean(secret.token),
  appSecretConfigured: Boolean(secret.appSecret),
  version: secret.version,
  localWebhookVerified: response.status === 200 && body === challenge,
}));
db.close();
