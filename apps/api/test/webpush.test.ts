import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/lib/webpush.ts';

const expand = (prk: Buffer, info: Buffer, n: number) =>
  createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, n);

/** What a browser does with a push message: the inverse of encryptPayload. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const prkKey = createHmac('sha256', auth).update(shared).digest();
  const ikm = expand(
    prkKey,
    Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]),
    32,
  );
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString();
}

describe('web push', () => {
  it('encrypts so that only the subscribed browser can read it', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const sub = {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    };
    const body = encryptPayload(Buffer.from('{"title":"ENG-12"}'), sub);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decrypt(body, ua, auth)).toBe('{"title":"ENG-12"}');
    // A different auth secret can't open it.
    expect(() => decrypt(body, ua, Buffer.alloc(16, 8))).toThrow();
  });

  it('matches the RFC 8291 example (Appendix A)', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      {
        serverPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs a VAPID token for the push service', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'mailto:x@y.z',
    );
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = jwt!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:x@y.z' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({
      format: 'jwk',
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
  });
});
