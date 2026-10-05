import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pageId = '1295897783615114';
const accountId = '7b4a8a24-5bd9-4e57-bf2e-38871f3a18e7';
const userToken = process.env.USER_TOKEN;
if (!userToken) throw new Error('Token temporário ausente.');

const key = readFileSync(resolve('data', 'secret.key'));
const db = new DatabaseSync(resolve('data', 'central.sqlite'));
const decrypt = value => {
  const b = Buffer.from(value, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
};
const encrypt = value => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
};
const graph = async (path, token, options = {}) => {
  const response = await fetch(`https://graph.facebook.com/v26.0/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Graph API recusou a operação (HTTP ${response.status}, código ${body.error?.code || 'desconhecido'}).`);
  return body;
};

try {
  const messenger = db.prepare('SELECT * FROM accounts WHERE id=? AND channel=?').get(accountId, 'messenger');
  if (!messenger) throw new Error('Conta local do Messenger não foi encontrada.');
  const oldSecret = decrypt(messenger.secret);
  if (!oldSecret.appSecret) throw new Error('App Secret do Messenger não está configurado.');

  const page = await graph(`${pageId}?fields=id,name,access_token`, userToken);
  if (page.id !== pageId || !page.access_token) throw new Error('A Página não retornou um token de acesso.');

  const subscribedFields = 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads';
  await graph(`${pageId}/subscribed_apps?subscribed_fields=${encodeURIComponent(subscribedFields)}`, page.access_token, { method: 'POST' });
  const subscriptions = await graph(`${pageId}/subscribed_apps?fields=id,name,subscribed_fields`, page.access_token);
  const app = subscriptions.data?.find(item => item.id === '1062549136589562');
  if (!app) throw new Error('A assinatura do aplicativo não foi confirmada.');

  const updatedSecret = encrypt({ ...oldSecret, token: page.access_token, version: 'v26.0' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE accounts SET name=?,external=?,secret=?,mode=? WHERE id=?').run(
      page.name || 'Acquarella Comunicação', pageId, updatedSecret, 'live', accountId,
    );
    db.prepare('INSERT INTO audit VALUES(?,?,?,?)').run(
      randomUUID(), messenger.tenant, 'Messenger conectado à Página Acquarella Comunicação.', Date.now(),
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    page: { id: page.id, name: page.name },
    appSubscribed: true,
    subscribedFields: app.subscribed_fields || [],
    localAccountMode: 'live',
  }));
} finally {
  db.close();
}
