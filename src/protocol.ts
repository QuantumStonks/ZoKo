import { z } from 'zod';

/** Application resource limits are deliberately smaller than Jev's token limits. */
export const MAX_INPUT_BYTES = 32_768;
export const MAX_QUESTIONS = 20;
export const MAX_JSON_DEPTH = 24;
const MAX_JSON_VALUES = 8_192;
const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonEntry = string | JsonValue[] | { [key: string]: JsonValue };

/** Iterative validation bounds nesting before any recursive serialization occurs. */
function validateJson(value: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const current = item.value;
    if (item.exit) {
      ancestors.delete(current as object);
      continue;
    }
    if (++count > MAX_JSON_VALUES) return 'JSON contains too many values';
    if (item.depth > MAX_JSON_DEPTH) return `JSON nesting exceeds ${MAX_JSON_DEPTH} levels`;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'string') {
      if (current.length > MAX_INPUT_BYTES) return 'JSON string exceeds the input limit';
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return 'JSON numbers must be finite';
      continue;
    }
    if (typeof current !== 'object') return 'Only JSON values are accepted';
    if (ancestors.has(current)) return 'Cyclic values are not JSON';
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (!array && prototype !== Object.prototype && prototype !== null) return 'JSON objects must be plain objects';
    const keys = Reflect.ownKeys(current);
    if (keys.length > MAX_JSON_VALUES + 1) return 'JSON contains too many fields';
    if (array && current.length > MAX_JSON_VALUES) return 'JSON contains too many array entries';
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, exit: true });
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return 'JSON cannot contain symbol keys';
      if (key.length > MAX_INPUT_BYTES) return 'JSON key exceeds the input limit';
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) {
        return 'JSON arrays cannot have named properties';
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return 'JSON cannot contain accessors or hidden fields';
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (array && keys.length !== current.length + 1) return 'Sparse arrays are not accepted';
  }
  return undefined;
}

const boundedJson = z.unknown().superRefine((value, context) => {
  try {
    const issue = validateJson(value);
    if (issue) {
      context.addIssue({ code: 'custom', message: issue });
      return;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_INPUT_BYTES) {
      context.addIssue({ code: 'custom', message: `Input JSON exceeds ${MAX_INPUT_BYTES} UTF-8 bytes` });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'Input must be bounded JSON data' });
  }
});

function isEntry(value: unknown): value is JsonEntry {
  return typeof value === 'string' || (typeof value === 'object' && value !== null);
}

const EntrySchema = z.custom<JsonEntry>(isEntry, 'Expected text, a JSON object, or an array');
const DescriptionSchema = EntrySchema.nullable();
const LabelSchema = z.string().min(1).max(128).refine(key => !reservedKeys.has(key), 'Reserved object key');
// Zod records intentionally discard __proto__; reject it before parsing so validation
// cannot silently change a quoted or billed question set.
const NamedMapGuard = z.unknown().refine(value => value === null || typeof value !== 'object'
  || Object.keys(value).every(key => !reservedKeys.has(key)), 'Reserved object key');
const NoulSchema = z.strictObject({
  type: z.literal('noul'),
  instructions: DescriptionSchema.optional(),
  criteria: z.strictObject({ true: DescriptionSchema.optional(), false: DescriptionSchema.optional() }).nullable().optional(),
});
const ChoiceSchema = z.strictObject({
  type: z.literal('choice'),
  instructions: DescriptionSchema.optional(),
  criteria: NamedMapGuard.pipe(z.record(LabelSchema, DescriptionSchema)).refine(
    value => Object.keys(value).length >= 1 && Object.keys(value).length <= 255,
    'Choice requires between 1 and 255 options',
  ),
});
const ScoreSchema = z.strictObject({
  type: z.literal('score'),
  instructions: DescriptionSchema.optional(),
  criteria: z.array(EntrySchema).min(2).max(10),
});

// Protocol: https://docs.typesafe.ai/api and the official SDK's generated wire schemas.
// Instructions may be absent/null in the wire schema; descriptive questions are recommended.
export const QuestionSchema = z.discriminatedUnion('type', [NoulSchema, ChoiceSchema, ScoreSchema]);
export type Question = z.infer<typeof QuestionSchema>;
export const DecisionInputSchema = boundedJson.pipe(z.strictObject({
  state: EntrySchema,
  questions: NamedMapGuard.pipe(z.record(LabelSchema, QuestionSchema)).refine(
    value => Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_QUESTIONS,
    `Provide between 1 and ${MAX_QUESTIONS} questions`,
  ),
}));
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
