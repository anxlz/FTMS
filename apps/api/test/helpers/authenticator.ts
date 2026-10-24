import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

/**
 * A software platform authenticator for the tests: an ES256 key pair that
 * answers WebAuthn registration and authentication ceremonies exactly as a
 * phone's biometric passkey would (user present + user verified), so the API's
 * real verification code is exercised end to end. Never used outside tests.
 */

type Cbor = number | string | Buffer | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Minimal canonical CBOR encoder (integers, strings, bytes, arrays, maps). */
export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, text.length), text]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const parts = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const b64 = (data: Buffer) => data.toString('base64url');

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}
interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export interface CeremonyOverrides {
  origin?: string;
  rpId?: string;
  /** The authenticator reports the user as verified (biometrics passed). */
  userVerified?: boolean;
  /** Override the user handle in an assertion (null: omit it). */
  userHandle?: string | null;
  /** Sign with a different key than the registered one. */
  forgeSignature?: boolean;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private counter = 0;
  /** The account handle learned at registration (base64url of the user id bytes). */
  userHandle: string | null = null;

  constructor(private readonly origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.x = Buffer.from(jwk.x!, 'base64url');
    this.y = Buffer.from(jwk.y!, 'base64url');
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  }

  private flags(uv: boolean, attested: boolean): number {
    return 0x01 | (uv ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  private counterBytes(): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(this.counter);
    return b;
  }

  /** Answers `navigator.credentials.create()` with the options the API returned. */
  register(options: Record<string, unknown>, overrides: CeremonyOverrides = {}) {
    const o = options as unknown as CreationOptions;
    const rpId = overrides.rpId ?? o.rp.id ?? 'localhost';
    this.userHandle = o.user.id;
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(overrides.userVerified ?? true, true)]),
      this.counterBytes(),
      Buffer.alloc(16), // AAGUID (none)
      idLength,
      this.credentialId,
      cose,
    ]);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64(
          this.clientData('webauthn.create', o.challenge, overrides.origin ?? this.origin),
        ),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Answers `navigator.credentials.get()` (biometric sign-in or check-in confirmation). */
  assert(options: Record<string, unknown>, overrides: CeremonyOverrides = {}) {
    const o = options as unknown as RequestOptions;
    const rpId = overrides.rpId ?? o.rpId ?? 'localhost';
    this.counter += 1;
    const authenticatorData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(overrides.userVerified ?? true, false)]),
      this.counterBytes(),
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.get',
      o.challenge,
      overrides.origin ?? this.origin,
    );
    const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
    const key = overrides.forgeSignature
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
      : this.privateKey;
    const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        authenticatorData: b64(authenticatorData),
        clientDataJSON: b64(clientDataJSON),
        signature: b64(sign('sha256', signed, key)),
        ...(userHandle ? { userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
