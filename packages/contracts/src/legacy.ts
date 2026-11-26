import { Type,type Static } from 'typebox';
import { UuidSchema,CentsSchema } from './common.js';
import { ProductInput,CustomerInput } from './catalog-stock.js';
const closed={additionalProperties:false},source_record_id=Type.String({minLength:1,maxLength:120}),row=(kind:string,data:ReturnType<typeof Type.Object>)=>Type.Object({source_record_id,kind:Type.Literal(kind),data},closed);
export const LegacyFileSchema=Type.Object({format:Type.Literal(1),batch_id:UuidSchema,source:Type.String({minLength:1,maxLength:120}),rows:Type.Array(Type.Union([
 row('category',Type.Object({name:Type.String({minLength:1,maxLength:120}),active:Type.Optional(Type.Boolean())},closed)),
 row('product',ProductInput),row('customer',CustomerInput),
 row('opening_stock',Type.Object({product_id:UuidSchema,quantity_milli:Type.Integer({minimum:1000,maximum:Number.MAX_SAFE_INTEGER,multipleOf:1000}),unit_cost_cents:Type.Union([CentsSchema,Type.Null()])},closed)),
 ]),{minItems:1,maxItems:10000})},closed);
export type LegacyFileDto=Static<typeof LegacyFileSchema>;
