import { PaymentError } from './money.js';

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
