import type { Db } from './db.js';
import { paymentsMigration, paymentsUpgradeMigration } from './payments/migration.js';

export const SCHEMA_VERSION = 3;

const schema = `
CREATE TABLE IF NOT EXISTS zoko_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE accounts (
 id uuid PRIMARY KEY, name text NOT NULL, api_key_hash text NOT NULL UNIQUE,
 deposit_address text UNIQUE, daily_limit_nanos numeric(40,0) NOT NULL CHECK(daily_limit_nanos>=0),
 max_price_nanos numeric(40,0) NOT NULL CHECK(max_price_nanos>=0), allowed_sellers text[],
 disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallets(id text PRIMARY KEY, balance numeric(40,0) NOT NULL DEFAULT 0, CHECK(id='external' OR balance>=0));
INSERT INTO wallets(id) VALUES('external'),('platform');
CREATE TABLE transfers(
 id bigserial PRIMARY KEY, reference text NOT NULL UNIQUE,
 from_wallet text NOT NULL REFERENCES wallets(id), to_wallet text NOT NULL REFERENCES wallets(id),
 amount numeric(40,0) NOT NULL CHECK(amount>0), metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(from_wallet<>to_wallet)
);
CREATE INDEX transfers_from_idx ON transfers(from_wallet,id DESC);
CREATE INDEX transfers_to_idx ON transfers(to_wallet,id DESC);
CREATE FUNCTION reject_journal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Transfer journal is append-only'; END $$;
CREATE TRIGGER transfers_immutable BEFORE UPDATE OR DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();
CREATE TABLE sellers(
 id text PRIMARY KEY, name text NOT NULL, endpoint text NOT NULL, api_key_encrypted text NOT NULL,
 model text NOT NULL, price_nanos numeric(40,0) NOT NULL CHECK(price_nanos>0),
 payout_account_id uuid REFERENCES accounts(id), enabled boolean NOT NULL DEFAULT true,
 paused boolean NOT NULL DEFAULT false,
 failures integer NOT NULL DEFAULT 0, circuit_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT sellers_enabled_requires_owner CHECK(NOT enabled OR payout_account_id IS NOT NULL)
);
CREATE TABLE quotes(
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), seller_id text NOT NULL REFERENCES sellers(id),
 request_hash text NOT NULL, schema_hash text NOT NULL, price_nanos numeric(40,0) NOT NULL,
 endpoint text NOT NULL, api_key_encrypted text NOT NULL, model text NOT NULL,
 payout_account_id uuid REFERENCES accounts(id), fee_bps integer NOT NULL,
 timeout_ms integer NOT NULL, min_confidence double precision NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE budgets(
 account_id uuid NOT NULL REFERENCES accounts(id), day date NOT NULL,
 spent numeric(40,0) NOT NULL DEFAULT 0 CHECK(spent>=0), reserved numeric(40,0) NOT NULL DEFAULT 0 CHECK(reserved>=0),
 PRIMARY KEY(account_id,day)
);
CREATE TABLE decisions(
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id), quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
 idempotency_key text NOT NULL, request_hash text NOT NULL, seller_id text NOT NULL REFERENCES sellers(id),
 price_nanos numeric(40,0) NOT NULL, budget_day date NOT NULL,
 status text NOT NULL CHECK(status IN ('running','succeeded','failed','indeterminate')),
 expires_at timestamptz NOT NULL, response jsonb, error_code text, latency_ms integer,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(account_id,idempotency_key)
);
CREATE INDEX decisions_owner_idx ON decisions(account_id,created_at DESC);
CREATE INDEX decisions_seller_idx ON decisions(seller_id,created_at DESC) INCLUDE(latency_ms) WHERE status='succeeded';
CREATE INDEX decisions_pending_idx ON decisions(expires_at) WHERE status='running';
CREATE TABLE audit_events(id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL, subject text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_journal_mutation();
`;

const marketplaceUpgradeMigration = `
ALTER TABLE sellers ADD COLUMN paused boolean NOT NULL DEFAULT false;
-- Keep legacy offers, frozen quotes, receipts and financial evidence. An offer
-- without an agent settlement account cannot accept new marketplace work.
UPDATE sellers SET enabled=false WHERE payout_account_id IS NULL;
ALTER TABLE sellers ADD CONSTRAINT sellers_enabled_requires_owner
 CHECK(NOT enabled OR payout_account_id IS NOT NULL);
`;

export async function migrate(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(71520761)');
    await client.query('CREATE TABLE IF NOT EXISTS zoko_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await client.query('SELECT version FROM zoko_migrations ORDER BY version DESC LIMIT 1');
    if (!existing.rowCount) {
      await client.query(schema); await client.query(paymentsMigration);
      await client.query('INSERT INTO zoko_migrations(version) VALUES($1)',[SCHEMA_VERSION]);
    } else {
      let version = existing.rows[0].version;
      if (version === 1) {
        // Add durable HD-wallet state without replacing legacy identities or payment evidence.
        // The payment preflight separately rejects any unsafe wallet reinterpretation.
        await client.query(paymentsUpgradeMigration);
        await client.query('INSERT INTO zoko_migrations(version) VALUES(2)');
        version = 2;
      }
      if (version === 2) {
        await client.query(marketplaceUpgradeMigration);
        await client.query('INSERT INTO zoko_migrations(version) VALUES(3)');
        version = 3;
      }
      if (version !== SCHEMA_VERSION) throw new Error('Unsupported database schema version');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
