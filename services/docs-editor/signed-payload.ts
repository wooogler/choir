import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from 'services/common/data-path';

const SIGNING_KEY_LENGTH = 32;

let cachedKey: Buffer | undefined;

function getSigningKey(): Buffer {
  if (cachedKey) return cachedKey;

  const configured =
    process.env.CHOIR_DOCS_EDITOR_SIGNING_KEY ||
    process.env.CHOIR_DB_ENCRYPTION_KEY ||
    process.env.DATABASE_ENCRYPTION_KEY;

  if (configured) {
    cachedKey = /^[a-fA-F0-9]{64}$/.test(configured)
      ? Buffer.from(configured, 'hex')
      : crypto.createHash('sha256').update(configured).digest();
    return cachedKey;
  }

  const keyFilePath = path.resolve(
    process.cwd(),
    process.env.CHOIR_DOCS_EDITOR_KEY_FILE || getDataPath('.choir-docs-editor-key'),
  );

  if (fs.existsSync(keyFilePath)) {
    cachedKey = Buffer.from(fs.readFileSync(keyFilePath, 'utf-8').trim(), 'hex');
    return cachedKey;
  }

  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  const generated = crypto.randomBytes(SIGNING_KEY_LENGTH).toString('hex');
  fs.writeFileSync(keyFilePath, `${generated}\n`, { encoding: 'utf-8', mode: 0o600 });
  cachedKey = Buffer.from(generated, 'hex');
  return cachedKey;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function hmac(payloadBuf: Buffer, purpose: string): Buffer {
  return crypto.createHmac('sha256', getSigningKey()).update(`${purpose}:`).update(payloadBuf).digest();
}

export interface SignedPayload<T> {
  payload: T;
  exp: number;
}

export function signPayload<T>(purpose: string, payload: T, ttlMs: number): string {
  const wrapped: SignedPayload<T> = { payload, exp: Date.now() + ttlMs };
  const payloadBuf = Buffer.from(JSON.stringify(wrapped), 'utf-8');
  const signature = hmac(payloadBuf, purpose);
  return `${base64UrlEncode(payloadBuf)}.${base64UrlEncode(signature)}`;
}

export type VerifyResult<T> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export function verifyPayload<T>(purpose: string, value: string): VerifyResult<T> {
  if (!value || typeof value !== 'string' || !value.includes('.')) {
    return { ok: false, reason: 'malformed' };
  }

  const [payloadPart, signaturePart] = value.split('.');
  if (!payloadPart || !signaturePart) {
    return { ok: false, reason: 'malformed' };
  }

  let payloadBuf: Buffer;
  let providedSignature: Buffer;
  try {
    payloadBuf = base64UrlDecode(payloadPart);
    providedSignature = base64UrlDecode(signaturePart);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedSignature = hmac(payloadBuf, purpose);
  if (
    providedSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  let wrapped: SignedPayload<T>;
  try {
    wrapped = JSON.parse(payloadBuf.toString('utf-8')) as SignedPayload<T>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof wrapped.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (Date.now() > wrapped.exp) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload: wrapped.payload };
}
