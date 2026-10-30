import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts secrets stored in the database (OIDC client secrets, integration tokens…) with
 * AES-256-GCM. Each value is bound to where it lives (`table:id:column`) through the GCM
 * associated data, so a ciphertext copied into another row or column fails to decrypt.
 *
 * Format: v1.<kid>.<iv>.<tag>.<ciphertext>, all base64url. `kid` identifies the key, which lets
 * ORDO_SECRET_KEY_PREVIOUS keep decrypting old values during a rotation.
 */
export class Keyring {
  private keys: { kid: string; key: Buffer }[] = [];
  private master: Buffer | null;

  constructor(current: Buffer | null, previous: Buffer | null = null) {
    for (const master of [current, previous]) {
      if (!master) continue;
      this.keys.push({ kid: keyId(master), key: derive(master, 'secrets') });
    }
    this.master = current;
  }

  get available() {
    return this.keys.length > 0 && this.master !== null;
  }

  /** A per-purpose subkey (e.g. 'file-url', 'totp'), so one leaked use can't be replayed in another. */
  subkey(purpose: string): Buffer {
    if (!this.master) throw new SecretKeyMissingError();
    return derive(this.master, purpose);
  }

  encrypt(plaintext: string, aad: string): string {
    const current = this.master ? this.keys[0] : undefined;
    if (!current) throw new SecretKeyMissingError();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', current.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', current.kid, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join('.');
  }

  decrypt(value: string, aad: string): string {
    const [version, kid, iv, tag, ct] = value.split('.');
    if (version !== 'v1' || !kid || !iv || !tag || ct === undefined)
      throw new Error('Malformed encrypted value');
    const entry = this.keys.find((k) => k.kid === kid);
    if (!entry) throw new Error('Encrypted with an unknown key (is ORDO_SECRET_KEY_PREVIOUS set?)');
    const decipher = createDecipheriv('aes-256-gcm', entry.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True when the value was encrypted with a key other than the current one. */
  needsRotation(value: string): boolean {
    return value.split('.')[1] !== this.keys[0]?.kid;
  }

  /** Ids of the keys this keyring can decrypt with: current first, then previous. */
  get keyIds(): string[] {
    return this.keys.map((k) => k.kid);
  }
}

export class SecretKeyMissingError extends Error {
  constructor() {
    super(
      'ORDO_SECRET_KEY is not set, so secrets cannot be stored. Run `make update` or set it in .env.',
    );
  }
}

const b64 = (b: Buffer) => b.toString('base64url');
const keyId = (master: Buffer) => createHash('sha256').update(master).digest('hex').slice(0, 8);
const derive = (master: Buffer, purpose: string) =>
  Buffer.from(hkdfSync('sha256', master, Buffer.from('ordo'), Buffer.from(purpose), 32));
