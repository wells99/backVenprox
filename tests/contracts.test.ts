import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import formats, { type FormatsPlugin } from 'ajv-formats';
import { Type } from 'typebox';
import { CentsSchema, QuantityMilliSchema, DecimalCursorSchema, UuidSchema, UtcInstantSchema,
  BusinessDateSchema, normalizeName, normalizeNote, normalizeInternalCode, normalizeLoginKey,
  searchKey, validateBarcode, validateTimeZone, withinPayloadLimits, collectionSchema } from '../packages/contracts/src/common.js';

const ajv = new Ajv({ strict: false, coerceTypes: false, removeAdditional: false });
(formats as unknown as FormatsPlugin)(ajv);
test('texto normalizado por campo preserva apresentação, SQL, zeros e significado de credenciais', () => {
  assert.equal(normalizeName('  Cafe\u0301  '), 'Café');
  assert.equal(normalizeName('Café'), normalizeName('Cafe\u0301'));
  assert.equal(normalizeName("D'Ávila; DROP TABLE sales;"), "D'Ávila; DROP TABLE sales;");
  assert.equal(normalizeNote(' a\r\nb '), 'a\nb');
  assert.throws(() => normalizeName('a\nb'));
  assert.throws(() => normalizeName('a\u200bb'));
  assert.throws(() => normalizeNote('a\u202eb'));
  assert.throws(() => normalizeInternalCode('ß'.repeat(64)));
  assert.equal(normalizeInternalCode(' ab-á '), 'AB-Á');
  assert.equal(normalizeLoginKey(' Pessoa '), 'pessoa');
  assert.equal(searchKey('Café'), 'cafe');
  assert.equal(validateBarcode('000123'), '000123');
  assert.throws(() => validateBarcode(' 123 '));
  assert.equal(validateTimeZone('America/Sao_Paulo'), 'America/Sao_Paulo');
  assert.throws(() => validateTimeZone('+03:00'));
  assert.throws(() => validateTimeZone('Mars/Unknown'));
});
test('valores monetários e quantidades usam inteiros seguros; cursores usam strings', () => {
  const money = ajv.compile(CentsSchema);
  for (const value of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1, '10', NaN, Infinity]) assert.equal(money(value), false);
  assert.equal(money(Number.MAX_SAFE_INTEGER), true);
  assert.equal(ajv.validate(QuantityMilliSchema, 0), false);
  assert.equal(ajv.validate(DecimalCursorSchema, '90071992547409930'), true);
  assert.equal(ajv.validate(DecimalCursorSchema, 12), false);
  assert.equal(ajv.validate(UuidSchema, '550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(ajv.validate(UuidSchema, '550E8400-e29b-41d4-a716-446655440000'), false);
  assert.equal(ajv.validate(UtcInstantSchema, '2026-11-24T10:00:00Z'), true);
  assert.equal(ajv.validate(UtcInstantSchema, '2026-11-24T10:00:00-03:00'), false);
  assert.equal(ajv.validate(BusinessDateSchema, '2026-02-30'), false);
});
test('PATCH distingue ausente/null/vazio; limites de estrutura e coleção são explícitos', () => {
  const schema = Type.Object({ name: Type.Optional(Type.String({ minLength: 1 })), note: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, { additionalProperties: false });
  assert.equal(ajv.validate(schema, {}), true);
  assert.equal(ajv.validate(schema, { name: null }), false);
  assert.equal(ajv.validate(schema, { name: '' }), false);
  assert.equal(ajv.validate(schema, { note: null }), true);
  assert.equal(ajv.validate(schema, { unknown: true }), false);
  assert.equal(ajv.validate(collectionSchema(Type.String(), 1), { data: { items: ['a','b'] }, meta: { request_id: 'test' } }), false);
  assert.equal(withinPayloadLimits(Array(101).fill(1)), false);
  assert.equal(withinPayloadLimits('é'.repeat(40000)), false);
  let nested: unknown = 1;
  for (let i = 0; i < 18; i++) nested = { nested };
  assert.equal(withinPayloadLimits(nested), false);
});
