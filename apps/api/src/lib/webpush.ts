import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Web Push without a library: VAPID (RFC 8292) to identify this server to the browser's push
 * service, and aes128gcm message encryption (RFC 8291, RFC 8188) so only the subscribed browser
 * can read the payload. Keys are P-256, base64url, as browsers hand them out.
 */

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Uncompressed point, 65 bytes; what `PushManager.subscribe` takes as applicationServerKey. */
  publicKey: string;
  /** The private scalar, 32 bytes. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** The `Authorization` header for a request to `endpoint`, valid for 12 hours. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string) {
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
  });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** HKDF-SHA256, expand step only (the extract step is the HMAC that makes `prk`). */
const expand = (prk: Buffer, info: Buffer, length: number) =>
  createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);

/** Encrypts `payload` for one subscription; returns the request body (one aes128gcm record). */
export function encryptPayload(
  payload: Buffer,
  subscription: { p256dh: string; auth: string },
  // Fixed only by tests, to compare against known output.
  fixed?: { serverPrivateKey: Buffer; salt: Buffer },
) {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  const server = createECDH('prime256v1');
  if (fixed) server.setPrivateKey(fixed.serverPrivateKey);
  else server.generateKeys();
  const asPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const prkKey = createHmac('sha256', authSecret).update(sharedSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (only) record; no padding.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}
