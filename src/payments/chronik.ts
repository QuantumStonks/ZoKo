import { ChronikClient, type Tx } from 'chronik-client';
import { boundedBody } from './transport.js';
import { PaymentError } from './money.js';

export class ChronikHttpError extends PaymentError {
  constructor(public readonly httpStatus: number) {
    super('chronik_http_error', `Chronik returned HTTP ${httpStatus}`);
  }
}

/**
 * The upstream client handles protobuf. Its public transport interface is replaced
 * with bounded, abortable fetch because its default Axios transport has no timeout.
 * Endpoint selection requires a pinned network checkpoint and token-index canary.
 * The selected service remains trusted for chain inclusion and finality.
 */
export class ChronikGateway {
  readonly client: ChronikClient;
  constructor(readonly url: string, private readonly timeoutMs = 15_000) {
    this.client = new ChronikClient([url]);
    const proxy = this.client.proxyInterface();
    proxy.get = path => this.request(path, 'GET');
    proxy.post = (path, data) => this.request(path, 'POST', data);
  }

  async request(path: string, method: 'GET' | 'POST', data?: Uint8Array): Promise<Uint8Array> {
    try {
      const response = await fetch(`${this.url}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/x-protobuf' },
        ...(data ? { body: Buffer.from(data) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ChronikHttpError(response.status);
      }
      return await boundedBody(response, 8 * 1024 * 1024);
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      throw new PaymentError('chronik_unavailable', 'Chronik is unavailable or timed out');
    }
  }

  tx(id: string): Promise<Tx> { return this.client.tx(id); }
}

export function assertPlainXec(tx: Tx, source: 'indexed' | 'validation' = 'indexed'): void {
  // /validate-tx reports NORMAL even for native-only transactions. Accept that
  // status only for validation responses with no token data whatsoever; indexed
  // parents and on-chain payouts must still explicitly report NON_TOKEN.
  const nativeStatus = tx.tokenStatus === 'TOKEN_STATUS_NON_TOKEN' ||
    (source === 'validation' && tx.tokenStatus === 'TOKEN_STATUS_NORMAL');
  if (!nativeStatus || tx.tokenEntries.length !== 0 ||
      tx.tokenFailedParsings.length !== 0 || tx.inputs.some(input => input.token !== undefined) ||
      tx.outputs.some(output => output.token !== undefined)) {
    throw new PaymentError('unsupported_token_transaction', 'Zoko accepts native XEC transactions without token inputs or outputs', 400);
  }
}
