import { Type, type Static, type TSchema } from 'typebox';

export const RequestIdSchema = Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' });
export const UuidSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
export const CentsSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const QuantityMilliSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const DecimalCursorSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$', maxLength: 128 });
export const UtcInstantSchema = Type.String({ format: 'date-time', pattern: 'Z$' });
export const BusinessDateSchema = Type.String({ format: 'date' });
export const BarcodeSchema = Type.String({ pattern: '^[0-9]{1,64}$' });
export const MetaSchema = Type.Object({
  request_id: RequestIdSchema,
  next_cursor: Type.Optional(Type.Union([DecimalCursorSchema, Type.Null()])),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  as_of: Type.Optional(UtcInstantSchema),
  sync_state: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('synced'), Type.Literal('unknown')])),
}, { additionalProperties: false });
export function successSchema<T extends TSchema>(data: T) {
  const example = (data as TSchema & {example?: unknown}).example;
  return Type.Object({ data, meta: MetaSchema }, { additionalProperties: false,
    ...(example === undefined ? {} : { example: { data: example, meta: { request_id: 'example-request' } } }) });
}
export function collectionSchema<T extends TSchema>(item: T, maxItems = 100) {
  return successSchema(Type.Object({ items: Type.Array(item, { maxItems }) }, { additionalProperties: false }));
}
export const ErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(), message: Type.String(),
    field_errors: Type.Array(Type.Object({ path: Type.String(), code: Type.String(), message: Type.String() }, { additionalProperties: false })),
    retryable: Type.Boolean(), request_id: RequestIdSchema,
  }, { additionalProperties: false }),
}, { additionalProperties: false, example: { error: {
  code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a requisição.',
  field_errors: [], retryable: false, request_id: 'example-request',
} } });
export type ErrorResponse = Static<typeof ErrorSchema>;
export function errorResponse(code: string, message: string, requestId: string,
  fieldErrors: ErrorResponse['error']['field_errors'] = [], retryable = false): ErrorResponse {
  return { error: { code, message, field_errors: fieldErrors, retryable, request_id: requestId } };
}

export class ContractInputError extends Error {
  constructor(readonly field: string) { super('Campo inválido.'); }
}

function normalizeText(value: string, field: string, maxLength: number, multiline: boolean): string {
  const normalized = value.normalize('NFC').trim().replace(/\r\n?/g, '\n');
  const controls = multiline ? normalized.replaceAll('\n', '') : normalized;
  if (!normalized || [...normalized].length > maxLength || /[\p{Cc}\p{Cf}]/u.test(controls)) throw new ContractInputError(field);
  return normalized;
}
export const normalizeName = (value: string) => normalizeText(value, 'name', 120, false);
export const normalizeNote = (value: string) => normalizeText(value, 'note', 2000, true);
export const normalizeInternalCode = (value: string) => normalizeText(value.normalize('NFC').toUpperCase(), 'internal_code', 64, false);
export const normalizeLoginKey = (value: string) => normalizeText(value.normalize('NFC').toLowerCase(), 'login', 120, false);
export const searchKey = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function validateBarcode(value: string): string {
  if (!/^[0-9]{1,64}$/.test(value)) throw new ContractInputError('barcode');
  return value;
}
// Senha/token/assinatura/conteúdo canônico não recebem transformação.
export function validateTimeZone(value: string): string {
  if (value !== 'UTC' && !/^[A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?$/.test(value)) throw new ContractInputError('time_zone');
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { throw new ContractInputError('time_zone'); }
  return value;
}

export function withinPayloadLimits(value: unknown, maxDepth = 16, maxItems = 1000): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  let bytes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++count > maxItems || entry.depth > maxDepth) return false;
    if (typeof entry.value === 'string') {
      if (entry.value.length > 65536) return false;
      bytes += new TextEncoder().encode(entry.value).length;
      if (bytes > 65536) return false;
    }
    if (entry.value && typeof entry.value === 'object') {
      if (Array.isArray(entry.value) && entry.value.length > 100) return false;
      for (const child of Object.values(entry.value)) pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return true;
}
