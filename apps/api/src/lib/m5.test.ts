import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, hotp, totp, verifyTotp } from './totp';
import { ipMatches } from './ip';

describe('TOTP', () => {
  // RFC 6238 appendix B test secret: ASCII "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 4226/6238 test vectors', () => {
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224');
    expect(hotp(Buffer.from('12345678901234567890'), 9)).toBe('520489');
    // RFC 6238 SHA-1 vectors, last 6 digits.
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
    expect(totp(secret, 2_000_000_000_000)).toBe('279037');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 255, 77, 13]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('accepts one step of drift and rejects replays', () => {
    const now = 1_700_000_000_000;
    const code = totp(secret, now - 30_000);
    const step = verifyTotp(secret, code, { now });
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, { now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, totp(secret, now - 90_000), { now })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { now })).toBeNull();
  });

  it('makes distinct recovery codes', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  });
});

describe('ipMatches', () => {
  it('matches addresses and ranges for IPv4 and IPv6', () => {
    expect(ipMatches('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipMatches('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipMatches('192.168.1.5', ['10.0.0.0/8', '192.168.1.5'])).toBe(true);
    expect(ipMatches('192.168.1.6', ['192.168.1.5'])).toBe(false);
    expect(ipMatches('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipMatches('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipMatches('1.2.3.4', ['garbage', '1.2.3.0/99'])).toBe(false);
  });
});
