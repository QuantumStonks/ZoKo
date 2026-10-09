import { z } from 'zod';
import { MAX_INPUT_BYTES, type DecisionInput } from './protocol.js';

/** Seller declarations are contractual evidence, not independent capacity/permission verification. */
export const OfferContractSchema = z.strictObject({
  version: z.literal('zoko.inference-offer/1'),
  backend: z.string().min(1).max(128),
  modelIdentity: z.string().min(1).max(256),
  authorization: z.strictObject({
    sellerAuthorized: z.literal(true),
    resalePermitted: z.literal(true),
    basis: z.enum(['owned_weights_license', 'provider_agreement']),
    evidenceReference: z.string().min(1).max(256),
  }),
  questionTypes: z.array(z.enum(['noul', 'choice', 'score'])).min(1).max(3)
    .refine(v => new Set(v).size === v.length, 'Question types must be unique'),
  maxInputBytes: z.number().int().min(1).max(MAX_INPUT_BYTES),
  maxOutputBytes: z.number().int().min(1024).max(262144),
  maxOutputTokens: z.number().int().min(1).max(65536),
  maxConcurrency: z.number().int().min(1).max(100),
  deadlineMs: z.number().int().min(100).max(60000),
  usageRequirement: z.enum(['backend_reported_required', 'backend_reported_optional']),
});
export type OfferContract = z.infer<typeof OfferContractSchema>;
export function supportsInput(contract: OfferContract, input: DecisionInput): boolean {
  return Buffer.byteLength(JSON.stringify(input)) <= contract.maxInputBytes
    && Object.values(input.questions).every(q => contract.questionTypes.includes(q.type));
}
export const cancellationSemantics = {
  supported: false,
  httpAbortStopsInference: false,
  recovery: 'original_quote_input_account_and_idempotency_key',
  timeout: 'terminal_refund_fences_late_completion_without_proving_backend_stopped',
} as const;
