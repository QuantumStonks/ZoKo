import { randomUUID } from 'node:crypto';
import type { PaymentsConfig } from './config.js';
import { PaymentError, record, safeInteger } from './money.js';

export class RpcError extends PaymentError {
  constructor(public readonly rpcCode: number, method: string) {
    super('wallet_rpc_error', `Bitcoin ABC ${method} failed (RPC ${rpcCode})`);
  }
}

/** Preserve the original numeric token. JSON.parse's rounded Number is never used for money. */
export function parseExactJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value !== 'number') return value;
    if (!context || typeof context.source !== 'string') {
      throw new PaymentError('runtime_version', 'Exact RPC parsing requires Node.js 24');
    }
    return context.source;
  });
}

export async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > limit) {
    await response.body?.cancel();
    throw new PaymentError('upstream_response_limit', 'Payment service response exceeds the configured safety bound');
  }
  if (!response.body) throw new PaymentError('empty_upstream_response', 'Payment service returned no response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new PaymentError('upstream_response_limit', 'Payment service response exceeds the configured safety bound');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

export class AbcRpc {
  private readonly url: string;
  constructor(private readonly config: PaymentsConfig) {
    this.url = `${config.rpcUrl.replace(/\/$/, '')}/wallet/${encodeURIComponent(config.walletName)}`;
  }

  async call(method: string, params: unknown[] = []): Promise<unknown> {
    const id = randomUUID();
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Basic ${Buffer.from(`${this.config.rpcUsername}:${this.config.rpcPassword}`).toString('base64')}`,
        },
        body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
        signal: AbortSignal.timeout(this.config.rpcTimeoutMs ?? 15_000),
      });
      const body = await boundedBody(response, 16 * 1024 * 1024);
      let data: Record<string, unknown>;
      try { data = record(parseExactJson(new TextDecoder('utf-8', { fatal: true }).decode(body)), 'JSON-RPC'); }
      catch (error) {
        if (error instanceof PaymentError) throw error;
        throw new PaymentError('invalid_rpc_response', 'Bitcoin ABC returned malformed JSON');
      }
      if (data.id !== id) throw new PaymentError('rpc_id_mismatch', 'Bitcoin ABC returned an unexpected RPC response ID');
      if (data.error !== null && data.error !== undefined) {
        const error = record(data.error, 'RPC error');
        throw new RpcError(safeInteger(error.code, 'error code'), method);
      }
      if (!response.ok || !Object.hasOwn(data, 'result')) throw new PaymentError('wallet_rpc_http', `Bitcoin ABC returned HTTP ${response.status}`);
      return data.result;
    } catch (error) {
      if (error instanceof PaymentError) throw error;
      // Do not expose response text, authenticated URLs, or node diagnostics to clients.
      throw new PaymentError('wallet_rpc_unavailable', `Bitcoin ABC ${method} is unavailable or timed out`);
    }
  }
}
