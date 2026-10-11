import { randomBytes } from 'crypto';
import { FieldCipher } from './field-cipher';

describe('FieldCipher (AES-256-GCM)', () => {
  const cipher = new FieldCipher(randomBytes(32));

  it('round-trips plaintext', () => {
    expect(cipher.decrypt(cipher.encrypt('12-3456789'))).toBe('12-3456789');
  });

  it('uses a fresh IV so equal plaintexts produce different ciphertexts', () => {
    expect(cipher.encrypt('same')).not.toEqual(cipher.encrypt('same'));
  });

  it('does not leak plaintext into the stored value', () => {
    expect(cipher.encrypt('000123456789')).not.toContain('000123456789');
  });

  it('detects tampering via the auth tag', () => {
    const [v, iv, tag, ct] = cipher.encrypt('secret-value').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  it('fails with the wrong key', () => {
    const other = new FieldCipher(randomBytes(32));
    expect(() => other.decrypt(cipher.encrypt('x'))).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new FieldCipher(randomBytes(16))).toThrow();
  });
});
