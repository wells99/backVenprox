import {catalogText} from '../../../domain/src/catalog-stock.js';
import { createHash } from 'node:crypto';
import { Value } from 'typebox/value';
import { LegacyFileSchema } from '../../../contracts/src/legacy.js';
import type { LegacyFile } from '../../../application/src/legacy-import.js';
import { ApplicationError } from '../../../application/src/application-error.js';
export const legacyHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function legacyId(key:string){const bytes=createHash('sha256').update('venprox-legacy-v1:'+key).digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;}
export function validateLegacy(value:unknown):LegacyFile {
 if(!Value.Check(LegacyFileSchema,value))throw new ApplicationError('IMPORT_FORMAT_INVALID','Use o arquivo JSON padronizado e confira os campos/tipos.','content');
 const file=value as LegacyFile,records=new Set<string>(),codes=new Set<string>(),barcodes=new Set<string>();let stock=false,catalog=false;
 for(const row of file.rows){if(row.kind!=='opening_stock'){if(catalogText(row.data.name,120)===undefined)throw new ApplicationError('IMPORT_TEXT_INVALID','Nome inválido no lote.','content');if(row.kind==='product'&&catalogText(row.data.internal_code,64)===undefined)throw new ApplicationError('IMPORT_TEXT_INVALID','Código inválido no lote.','content');if(row.kind==='customer'){if(row.data.phone&&catalogText(row.data.phone,40)===undefined||row.data.email&&(catalogText(row.data.email,254)===undefined||!/^([^\s@]+)@([^\s@]+)\.[^\s@]+$/.test(row.data.email.trim())))throw new ApplicationError('IMPORT_TEXT_INVALID','Contato inválido no lote.','content');}}const key=row.kind+':'+row.source_record_id;if(records.has(key))throw new ApplicationError('IMPORT_DUPLICATE_SOURCE','Identificador de origem repetido.','content');records.add(key);
  if(row.kind==='opening_stock')stock=true;else catalog=true;
  if(row.kind==='product'){const code=row.data.internal_code.normalize('NFC').trim().toUpperCase();if(!code||codes.has(code))throw new ApplicationError('IMPORT_DUPLICATE_CODE','Código interno repetido ou vazio.','content');codes.add(code);for(const barcode of row.data.barcodes??[]){if(barcodes.has(barcode))throw new ApplicationError('IMPORT_DUPLICATE_BARCODE','Barcode repetido no lote.','content');barcodes.add(barcode);}}
 }
 if(stock&&catalog)throw new ApplicationError('IMPORT_SEPARATE_STOCK_BATCH','Importe primeiro os cadastros online; saldo inicial exige lote separado no terminal após download.','content');
 return file;
}
