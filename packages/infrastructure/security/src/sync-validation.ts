import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../domain/src/sync.js';
import type { SyncEnvelope, SyncTransaction, SyncReceipt } from '../../../application/src/sync-ports.js';
export { validateSyncPayload } from '../../../contracts/src/sync-payloads.js';
export const syncHashValue=(value:unknown)=>createHash('sha256').update(canonicalJson(value),'utf8').digest('hex');
export function syncEnvelopeHash(envelope:SyncEnvelope):string {const {payload_hash:_hash,...body}=envelope;return createHash('sha256').update(`venprox-sync-v1\n${canonicalJson(body)}`,'utf8').digest('hex');}
export const laboratoryPublication={publish:async(tx:SyncTransaction,envelope:SyncEnvelope,result:SyncReceipt['result'])=>{await tx.sync.stagePublication(envelope,result);}};
