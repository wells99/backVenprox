import { Type, type Static } from 'typebox';
import { RequestIdSchema, successSchema } from './common.js';

export const HealthSchema = Type.Object({ status: Type.Literal('ok') }, { additionalProperties: false });

export const CompatibilitySchema = successSchema(Type.Object({
    backend_version: Type.String(),
    minimum_app_version: Type.String(),
    supported_protocol_versions: Type.Array(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false }));

export type CompatibilityResponse = Static<typeof CompatibilitySchema>;

export const LocalCommandSchema = Type.Object({
  type: Type.Union([Type.Literal('diagnostics'), Type.Literal('shutdown')]),
  request_id: RequestIdSchema,
}, { additionalProperties: false });

export type LocalCommand = Static<typeof LocalCommandSchema>;
