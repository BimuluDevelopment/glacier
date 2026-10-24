import { describe, expect, it } from 'vitest';
import { Encrypter, randomToken, safeEqual, sha256 } from './crypto';

describe('Encrypter', () => {
  const enc = new Encrypter('a'.repeat(32));

  it('round-trips and uses a fresh IV every time', () => {
    const a = enc.encrypt('node-secret');
    const b = enc.encrypt('node-secret');
    expect(a).not.toBe(b);
    expect(enc.decrypt(a)).toBe('node-secret');
  });

  it('rejects tampered payloads and the wrong key', () => {
    const payload = enc.encrypt('node-secret');
    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => enc.decrypt(parts.join('.'))).toThrow();
    expect(() => new Encrypter('b'.repeat(32)).decrypt(payload)).toThrow();
  });
});

describe('helpers', () => {
  it('generates url-safe tokens and compares safely', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256('x')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
