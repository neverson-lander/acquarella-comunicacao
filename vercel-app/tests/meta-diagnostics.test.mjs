import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMetaAccount, inspectWhatsAppWindow } from '../lib/meta-diagnostics.mjs';

test('WhatsApp team window is open only for a valid inbound within 24 hours', () => {
  const now = 1790805000000;
  assert.equal(inspectWhatsAppWindow(String(now - 1000), now).open, true);
  assert.equal(inspectWhatsAppWindow(now - 86400000, now).open, false);
  for (const seen of [undefined, null, 0, 'invalid', now + 1000]) assert.equal(inspectWhatsAppWindow(seen, now).open, false);
  assert.equal(inspectWhatsAppWindow(undefined, now).expiresAt, null);
});

test('invalid tokens return a diagnosis without exposing provider messages or credentials', async () => {
  const result = await inspectMetaAccount({ mode: 'live', external: '123', channel: 'messenger' }, { token: 'private' }, async () => new Response(JSON.stringify({ error: { code: 190, message: 'private' } }), { status: 401 }));
  assert.equal(result.reason, 'invalid_token');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('Messenger diagnostic checks profile and page subscriptions', async () => {
  const paths = [];
  const result = await inspectMetaAccount({ mode: 'live', external: '123', channel: 'messenger' }, { token: 'private' }, async url => {
    paths.push(url);
    return new Response(JSON.stringify(url.includes('subscribed_apps') ? { data: [{ id: 'app', subscribed_fields: ['messages'], access_token: 'private' }] } : { id: '123', name: 'Page', access_token: 'private' }));
  });
  assert.equal(paths.length, 2);
  assert.equal(result.connected, true);
  assert.deepEqual(result.subscriptions, [{ id: 'app', fields: ['messages'] }]);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
