export const REDACTED = '[REDACTED]';

/**
 * Keys whose values must never reach logs or the audit trail. Keys are normalised
 * (lower-cased, `_`/`-` removed) and matched by substring, or exactly for short tokens that
 * would otherwise cause false positives (e.g. "ssn" inside "businessName").
 */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'taxid',
  'accountnumber',
  'routingnumber',
  'iban',
  'cardnumber',
  'dateofbirth',
];
const SENSITIVE_EXACT_KEYS = new Set(['ssn', 'dob', 'pin', 'cvv', 'cvc', 'pan']);

/** PII that is useful for operators in masked form (e.g. to recognise a record). */
const MASKED_KEY = /email|phone/i;

export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_EXACT_KEYS.has(k) || SENSITIVE_KEY_PARTS.some((part) => k.includes(part));
}

const MAX_DEPTH = 8;

export function maskTail(value: string, visible = 4): string {
  if (value.length <= visible) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(4, value.length - visible))}${value.slice(-visible)}`;
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return maskTail(email, 2);
  return `${email[0]}***${email.slice(at)}`;
}

function maskPii(key: string, value: string): string {
  return /email/i.test(key) ? maskEmail(value) : maskTail(value, 2);
}

/**
 * Deep-copies `input`, replacing secrets with `[REDACTED]` and masking contact PII.
 * Used before anything is written to the audit log or to structured logs.
 */
export function redact<T>(input: T, depth = 0): T {
  if (depth > MAX_DEPTH || input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1)) as T;
  if (input instanceof Date) return input;
  if (typeof input !== 'object') return input;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = value === null || value === undefined ? value : REDACTED;
    } else if (MASKED_KEY.test(key) && typeof value === 'string') {
      out[key] = maskPii(key, value);
    } else {
      out[key] = redact(value, depth + 1);
    }
  }
  return out as T;
}
