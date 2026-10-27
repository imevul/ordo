import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A WebAuthn authenticator in software, for tests: a P-256 key, `none` attestation, and
 * assertions signed the way a security key or a phone would. Overrides make it misbehave (another
 * origin, no user verification, an old counter) to test what the server refuses.
 */

const b64 = (bytes: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(bytes));
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

interface Overrides {
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
  counter?: number;
  userHandle?: string;
  type?: string;
}

export class SoftAuthenticator {
  private keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = new Uint8Array(randomBytes(16));
  counter = 0;
  private handle = '';

  constructor(private site: { origin: string; rpId: string }) {}

  get id() {
    return b64(this.credentialId);
  }

  private cosePublicKey() {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ]),
    );
  }

  private authData(flags: number, counter: number, rpId: string, extra?: Uint8Array) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha(rpId), Buffer.from([flags]), count, ...(extra ? [extra] : [])]);
  }

  /** Answers `navigator.credentials.create()` with these options. */
  register(
    options: { challenge: string; user: { id: string } },
    o: Overrides = {},
  ): Record<string, unknown> {
    this.handle = options.user.id;
    const clientData = JSON.stringify({
      type: o.type ?? 'webauthn.create',
      challenge: options.challenge,
      origin: o.origin ?? this.site.origin,
      crossOrigin: false,
    });
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([
      Buffer.alloc(16), // AAGUID: none
      idLength,
      this.credentialId,
      this.cosePublicKey(),
    ]);
    const flags = FLAG_UP | FLAG_AT | (o.userVerified === false ? 0 : FLAG_UV);
    const authData = this.authData(flags, this.counter, o.rpId ?? this.site.rpId, attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Map<string, string> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', new Uint8Array(authData)],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(new TextEncoder().encode(clientData)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** Answers `navigator.credentials.get()` with these options. */
  authenticate(options: { challenge: string }, o: Overrides = {}): Record<string, unknown> {
    this.counter = o.counter ?? this.counter + 1;
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: o.type ?? 'webauthn.get',
        challenge: options.challenge,
        origin: o.origin ?? this.site.origin,
        crossOrigin: false,
      }),
    );
    const flags = FLAG_UP | (o.userVerified === false ? 0 : FLAG_UV);
    const authData = this.authData(flags, this.counter, o.rpId ?? this.site.rpId);
    // ECDSA over authenticatorData ‖ sha256(clientDataJSON), DER-encoded as authenticators do.
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha(clientData)]),
      this.keys.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: o.userHandle ?? this.handle,
      },
      clientExtensionResults: {},
    };
  }
}
