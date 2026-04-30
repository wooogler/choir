import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from 'services/common/data-path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

function getLocalKeyFilePath(): string {
  return path.resolve(process.cwd(), process.env.CHOIR_DB_KEY_FILE || getDataPath('.choir-db-key'));
}

function getEncryptionKey(): Buffer {
  const configured = process.env.CHOIR_DB_ENCRYPTION_KEY || process.env.DATABASE_ENCRYPTION_KEY;

  if (configured) {
    if (/^[a-fA-F0-9]{64}$/.test(configured)) {
      return Buffer.from(configured, 'hex');
    }

    return crypto.createHash('sha256').update(configured).digest();
  }

  const keyFilePath = getLocalKeyFilePath();
  if (fs.existsSync(keyFilePath)) {
    return Buffer.from(fs.readFileSync(keyFilePath, 'utf-8').trim(), 'hex');
  }

  fs.mkdirSync(path.dirname(keyFilePath), { recursive: true });
  const generatedKey = crypto.randomBytes(KEY_LENGTH).toString('hex');
  fs.writeFileSync(keyFilePath, `${generatedKey}\n`, { encoding: 'utf-8', mode: 0o600 });
  return Buffer.from(generatedKey, 'hex');
}

export function encryptString(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey().subarray(0, KEY_LENGTH), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decryptString(value: string): string {
  const [version, ivBase64, tagBase64, encryptedBase64] = value.split(':');
  if (version !== 'v1' || !ivBase64 || !tagBase64 || !encryptedBase64) {
    throw new Error('Unsupported encrypted value format');
  }

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getEncryptionKey().subarray(0, KEY_LENGTH),
    Buffer.from(ivBase64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagBase64, 'base64'));

  return Buffer.concat([decipher.update(Buffer.from(encryptedBase64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encryptString(JSON.stringify(value));
}

export function decryptJson<T>(value: string): T {
  return JSON.parse(decryptString(value)) as T;
}
