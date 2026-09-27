import { createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function keyHash(key: string): string { return createHash('sha256').update(key).digest('hex'); }
export function issueKey(): string { return `zoko_${randomBytes(32).toString('base64url')}`; }
export function safeEqual(a: string, b: string): boolean { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new AppError(400, 'invalid_json', 'Only JSON data is supported');
  return encoded;
}
export const digest = (value: unknown): string => keyHash(canonical(value));
export function encrypt(secret: string, key: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  cipher.setAAD(Buffer.from('zoko-provider-v1'));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}
export function decrypt(encoded: string, key: string): string {
  const [version, iv, tag, body] = encoded.split(':');
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Invalid stored secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from('zoko-provider-v1')); decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
export function validateEndpoint(raw: string, hosts: string[]): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(400, 'invalid_endpoint', 'Invalid provider URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443') || isIP(url.hostname) || !hosts.includes(url.hostname.toLowerCase())) {
    throw new AppError(400, 'endpoint_not_allowed', 'Provider must use HTTPS on an exact operator-approved hostname');
  }
  return url.href;
}
