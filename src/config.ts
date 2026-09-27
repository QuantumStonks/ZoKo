import { z } from 'zod';
import { readPaymentsConfig, type PaymentsConfig } from './payments/index.js';

export const MoneySchema = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
export const PositiveMoneySchema = MoneySchema.refine(v => BigInt(v) > 0n, 'Must be positive');
export interface Config {
  databaseUrl: string; host: string; port: number; publicUrl: string;
  adminToken: string; encryptionKey: string; providerHosts: string[];
  providerMaxTimeoutMs: number; platformFeeBps: number; quoteTtlSeconds: number;
  payments: PaymentsConfig; production: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (['TYPESAFE_API_KEY', 'TYPESAFE_MODEL', 'ZOKO_JEV_PRICE_NANOS'].some(name => env[name])) {
    throw new Error('Platform-owned provider settings are obsolete; remove them and register an agent-owned seller offer.');
  }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const adminToken = env.ZOKO_ADMIN_TOKEN ?? '';
  if (adminToken.length < 32 || /\s/.test(adminToken)) throw new Error('ZOKO_ADMIN_TOKEN must contain at least 32 non-whitespace characters');
  const encryptionKey = env.ZOKO_ENCRYPTION_KEY ?? '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('ZOKO_ENCRYPTION_KEY must be a base64-encoded random 32-byte key');
  const production = env.NODE_ENV === 'production';
  const publicUrl = env.ZOKO_PUBLIC_URL ?? 'http://localhost:3000';
  const url = new URL(publicUrl);
  if (production && url.protocol !== 'https:') throw new Error('Production ZOKO_PUBLIC_URL must use HTTPS');
  const providerHosts = (env.ZOKO_PROVIDER_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (providerHosts.some(h => /[\/:@*]/.test(h))) throw new Error('ZOKO_PROVIDER_HOSTS requires exact DNS hostnames, without wildcards or ports');
  return {
    databaseUrl, host: env.HOST ?? '0.0.0.0', port: integer('PORT', 3000, 1, 65535), publicUrl,
    adminToken, encryptionKey, providerHosts, production,
    providerMaxTimeoutMs: integer('ZOKO_PROVIDER_TIMEOUT_MS', 10000, 100, 60000),
    platformFeeBps: integer('ZOKO_PLATFORM_FEE_BPS', 1000, 0, 10000),
    quoteTtlSeconds: integer('ZOKO_QUOTE_TTL_SECONDS', 60, 5, 300),
    payments: readPaymentsConfig(env),
  };
}
