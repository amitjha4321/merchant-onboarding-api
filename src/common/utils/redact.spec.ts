import { isSensitiveKey, maskEmail, maskTail, redact, REDACTED } from './redact';

describe('redact', () => {
  it('redacts secrets and sensitive identifiers at any depth', () => {
    const out = redact({
      password: 'hunter2hunter2',
      passwordHash: '$2a$...',
      nested: { accessToken: 'jwt', Authorization: 'Bearer x', taxId: '12-3456789' },
      list: [{ settlementAccountNumber: '000123456789' }],
      ssn: '000-00-0000',
    });
    expect(out).toEqual({
      password: REDACTED,
      passwordHash: REDACTED,
      nested: { accessToken: REDACTED, Authorization: REDACTED, taxId: REDACTED },
      list: [{ settlementAccountNumber: REDACTED }],
      ssn: REDACTED,
    });
  });

  it('does not produce false positives on ordinary business fields', () => {
    for (const key of ['businessName', 'legalBusinessName', 'status', 'reason', 'assessment']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
    expect(redact({ businessName: 'Example Coffee' })).toEqual({ businessName: 'Example Coffee' });
  });

  it('masks contact PII instead of dropping it', () => {
    expect(redact({ email: 'jane.doe@example.com', ownerPhone: '+15555550123' })).toEqual({
      email: 'j***@example.com',
      ownerPhone: '**********23',
    });
  });

  it('keeps null/undefined values and does not mutate the input', () => {
    const input = { token: null, nested: { password: 'x' } };
    const out = redact(input);
    expect(out.token).toBeNull();
    expect(input.nested.password).toBe('x');
  });
});

describe('masking helpers', () => {
  it('maskTail shows only the last 4 characters', () => {
    expect(maskTail('123456789')).toBe('*****6789');
    expect(maskTail('123')).toBe('***');
  });
  it('maskEmail keeps first char and domain', () => {
    expect(maskEmail('someone@example.com')).toBe('s***@example.com');
  });
});
