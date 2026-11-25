import { createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as argon2 from 'argon2';
import type { AuthCrypto } from '../../../application/src/auth-ports.js';
import type { AuthorizedContext } from '../../../domain/src/authorization.js';
import { permissions } from '../../../domain/src/authorization.js';
import { ApplicationError } from '../../../application/src/application-error.js';

const passwordOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32 } as const;
export function generateAuthKeys() {
  const keys = generateKeyPairSync('ed25519');
  return { privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), fingerprintKey: randomBytes(32).toString('base64url') };
}
export function validateGrantContext(value: unknown): AuthorizedContext {
  if (!value || typeof value !== 'object') throw new Error('INVALID_GRANT');
  const context = value as AuthorizedContext;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuid.test(context.store_id) || !uuid.test(context.user_id) || !uuid.test(context.device_id ?? '') || !uuid.test(context.authorization_id) ||
      context.authorization_origin !== 'offline' || !Number.isSafeInteger(context.permissions_version) || context.permissions_version < 1 ||
      !Array.isArray(context.permissions) || context.permissions.some((permission) => !permissions.includes(permission)) ||
      !Number.isFinite(Date.parse(context.authorized_at)) || !Number.isFinite(Date.parse(context.expires_at)) || context.expires_at <= context.authorized_at) throw new Error('INVALID_GRANT');
  return context;
}
export function createAuthCrypto(privatePem: string, fingerprintKey: string): AuthCrypto {
  const privateKey = createPrivateKey(privatePem);
  const publicPem = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
  if (Buffer.from(fingerprintKey, 'base64url').length < 32) throw new Error('INVALID_AUTH_KEY');
  return {
    hashPassword: (password) => argon2.hash(password, passwordOptions),
    verifyPassword: async (hash, password) => { try { return await argon2.verify(hash, password); } catch { return false; } },
    token: () => randomBytes(32).toString('base64url'),
    digest: (value) => createHash('sha256').update(value).digest('hex'),
    fingerprint: (value) => createHmac('sha256', Buffer.from(fingerprintKey, 'base64url')).update(value).digest('hex'),
    signGrant: (context) => {
      const payload = Buffer.from(JSON.stringify(validateGrantContext(context))).toString('base64url');
      return `${payload}.${sign(null, Buffer.from(`venprox-offline-v1.${payload}`), privateKey).toString('base64url')}`;
    },
    verifyGrant: verifyOfflineGrant,
    publicKey: () => publicPem,
  };
}
export function verifyOfflineGrant(token: string, publicPem: string): AuthorizedContext {
  try {
    if (token.length > 16384) throw new Error();
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !verify(null, Buffer.from(`venprox-offline-v1.${payload}`), createPublicKey(publicPem), Buffer.from(signature, 'base64url'))) throw new Error();
    return validateGrantContext(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch { throw new ApplicationError('OFFLINE_AUTHORIZATION_INVALID', 'Autorização offline inválida.', 'forbidden'); }
}
export async function measurePasswordHash(crypto: AuthCrypto) {
  const started = performance.now();
  const hash = await crypto.hashPassword('benchmark-password-not-an-account');
  return { algorithm: 'argon2id', memory_kib: 19456, iterations: 2, parallelism: 1,
    duration_ms: Math.round(performance.now() - started), verified: await crypto.verifyPassword(hash, 'benchmark-password-not-an-account') };
}
