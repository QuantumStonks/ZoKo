export const paymentsUpgradeMigration = `
CREATE TABLE IF NOT EXISTS payments_addresses (
  network text NOT NULL,
  address text NOT NULL,
  account_id uuid REFERENCES accounts(id),
  branch smallint NOT NULL CHECK (branch IN (0,1)),
  derivation_index integer NOT NULL CHECK (derivation_index>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(network,address),
  UNIQUE(network,branch,derivation_index),
  UNIQUE(account_id),
  CHECK (branch=0 OR account_id IS NULL)
);
CREATE TABLE IF NOT EXISTS payments_address_scans (
  network text NOT NULL,
  address text NOT NULL,
  confirmed_offset bigint NOT NULL DEFAULT 0 CHECK(confirmed_offset>=0),
  anchor_height integer,
  anchor_hash text,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at timestamptz,
  last_error text,
  PRIMARY KEY(network,address),
  FOREIGN KEY(network,address) REFERENCES payments_addresses(network,address)
);
CREATE INDEX IF NOT EXISTS payments_address_scans_due ON payments_address_scans(next_scan_at,last_scanned_at);
ALTER TABLE payments_deposits ADD COLUMN IF NOT EXISTS block_height integer;
`;

export const paymentsMigration = `
CREATE TABLE IF NOT EXISTS payments_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments_deposit_txs (
  network text NOT NULL,
  txid text NOT NULL CHECK (txid ~ '^[0-9a-f]{64}$'),
  pending boolean NOT NULL DEFAULT true,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, txid)
);
CREATE INDEX IF NOT EXISTS payments_deposit_txs_pending ON payments_deposit_txs(next_check_at) WHERE pending;
CREATE TABLE IF NOT EXISTS payments_deposits (
  network text NOT NULL,
  txid text NOT NULL CHECK (txid ~ '^[0-9a-f]{64}$'),
  vout integer NOT NULL CHECK (vout >= 0),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount_nanos numeric(40,0) NOT NULL CHECK (amount_nanos > 0 AND mod(amount_nanos,10000000)=0),
  address text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','credited','unsupported','reorg_review')),
  confirmations integer NOT NULL DEFAULT 0,
  avalanche_finalized boolean NOT NULL DEFAULT false,
  block_hash text,
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, txid, vout)
);
CREATE INDEX IF NOT EXISTS payments_deposits_account ON payments_deposits(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS payments_withdrawals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  network text NOT NULL,
  idempotency_key text NOT NULL,
  address text NOT NULL,
  amount_nanos numeric(40,0) NOT NULL CHECK (amount_nanos > 0 AND mod(amount_nanos,10000000)=0),
  max_fee_nanos numeric(40,0) NOT NULL CHECK (max_fee_nanos > 0 AND mod(max_fee_nanos,10000000)=0),
  fee_nanos numeric(40,0) CHECK (fee_nanos >= 0 AND fee_nanos <= max_fee_nanos AND mod(fee_nanos,10000000)=0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','preparing','signed','broadcast','settled','failed','manual_review')),
  input_outpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  change_address text,
  funded_hex text,
  signed_hex text,
  txid text UNIQUE,
  last_error text,
  broadcast_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(account_id,idempotency_key),
  CHECK ((signed_hex IS NULL AND txid IS NULL) OR (signed_hex IS NOT NULL AND txid IS NOT NULL)),
  CHECK (status NOT IN ('signed','broadcast','settled','manual_review') OR signed_hex IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS payments_withdrawals_queue ON payments_withdrawals(created_at) WHERE status IN ('requested','preparing','signed','broadcast');
CREATE INDEX IF NOT EXISTS payments_withdrawals_account ON payments_withdrawals(account_id,created_at DESC);
${paymentsUpgradeMigration}
`;
