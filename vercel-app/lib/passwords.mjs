import { randomBytes, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto';

export function hash(value) {
  const salt = randomBytes(16).toString('hex');
  return `pbkdf2:${salt}:${pbkdf2Sync(value, salt, 210000, 32, 'sha256').toString('hex')}`;
}

export function verify(value, stored) {
  if (typeof value !== 'string' || value.length > 200) return false;
  const parts = String(stored).split(':');
  let actual, expected;
  if (parts.length === 3 && parts[0] === 'pbkdf2' && /^[a-f0-9]{64}$/.test(parts[2])) {
    expected = Buffer.from(parts[2], 'hex');
    actual = pbkdf2Sync(value, parts[1], 210000, 32, 'sha256');
  } else if (parts.length === 2 && /^[a-f0-9]{32}$/.test(parts[0]) && /^[a-f0-9]{128}$/.test(parts[1])) {
    expected = Buffer.from(parts[1], 'hex');
    actual = scryptSync(value, parts[0], 64);
  } else return false;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
