import test from 'node:test';
import assert from 'node:assert/strict';
import { sameWhatsAppPhone,knownWhatsAppRecipient } from '../lib/whatsapp-phone.mjs';

test('only the known team recipient is restored to its registered number',()=>{
  assert.equal(knownWhatsAppRecipient('553488748139','5534988748139'),'5534988748139');
  assert.equal(knownWhatsAppRecipient('5534999999999','5534988748139'),'5534999999999');
  assert.equal(knownWhatsAppRecipient('553488748139',undefined),'553488748139');
});

test('accepts the observed Meta legacy ID for the configured Brazilian mobile', () => {
  assert.equal(sameWhatsAppPhone('553488748139', '5534988748139'), true);
  assert.equal(sameWhatsAppPhone('5534988748139', '553488748139'), true);
  assert.equal(sameWhatsAppPhone('5534988748139', '5534988748139'), true);
});

test('rejects unrelated senders, landlines, international numbers and missing IDs', () => {
  for (const [sender, configured] of [
    ['553488748138', '5534988748139'],
    ['553588748139', '5534988748139'],
    ['543488748139', '5534988748139'],
    ['553432345678', '5534932345678'],
    ['15551939562', '155591939562'],
    ['', ''], [undefined, undefined], ['BR.12345', 'BR.12345'],
  ]) assert.equal(sameWhatsAppPhone(sender, configured), false);
});
