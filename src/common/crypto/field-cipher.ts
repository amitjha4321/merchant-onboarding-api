import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ValueTransformer } from 'typeorm';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
/** Version prefix lets us rotate keys / algorithms later without a big-bang migration. */
const VERSION = 'v1';

/**
 * Authenticated symmetric encryption for individual columns (AES-256-GCM).
 * Stored format: `v1:<iv b64>:<auth tag b64>:<ciphertext b64>`.
 *
 * In production the data key would come from a KMS (envelope encryption); here it is
 * supplied via FIELD_ENCRYPTION_KEY and validated on boot.
 */
export class FieldCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Field encryption key must be 32 bytes');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ciphertext] = payload.split(':');
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unsupported encrypted field format');
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}

let cipher: FieldCipher | undefined;
function getCipher(): FieldCipher {
  // Resolved lazily because entity decorators are evaluated at import time,
  // before Nest's ConfigModule has loaded/validated the environment.
  if (!cipher) {
    const key = process.env.FIELD_ENCRYPTION_KEY;
    if (!key) throw new Error('FIELD_ENCRYPTION_KEY is not configured');
    cipher = new FieldCipher(Buffer.from(key, 'base64'));
  }
  return cipher;
}

/** TypeORM column transformer: plaintext in the domain, ciphertext at rest. */
export const encryptedColumn: ValueTransformer = {
  to: (value: string | null | undefined) =>
    value === null || value === undefined ? value : getCipher().encrypt(value),
  from: (value: string | null) => (value === null ? value : getCipher().decrypt(value)),
};
