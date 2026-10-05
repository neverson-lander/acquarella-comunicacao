import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { hash, verify } from '../lib/passwords.mjs';

test('Preserva senhas scrypt da central local e aceita novos hashes PBKDF2', () => {
  const password = 'SenhaSomenteParaTeste123!';
  const salt = '1234567890abcdef1234567890abcdef';
  const legacy = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  for (const stored of [legacy, hash(password)]) {
    assert.equal(verify(password, stored), true);
    assert.equal(verify('OutraSenhaIncorreta123!', stored), false);
  }
  for (const stored of ['', 'invalid:hash', 'pbkdf2:salt:bad']) assert.equal(verify(password, stored), false);
  assert.equal(verify('x'.repeat(201), hash(password)), false);
});
