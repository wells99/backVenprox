import type { RecoverySummary } from './recovery.js';
import type { SyncReceipt } from './sync-ports.js';
import { ApplicationError } from './application-error.js';
export interface RecoveredOperation {operation_id:string;device_seq:string;payload_hash:string;acknowledged:boolean}
export async function reconcileRecoveredCopy(summary:RecoverySummary,receivedSeq:string,operations:RecoveredOperation[],sourceRetired:boolean,receipt:(id:string)=>Promise<SyncReceipt>){
 const fail=(code:string)=>{throw new ApplicationError(code,'Recuperação bloqueada; preserve ambas as bases e confira a origem, contador e recibos.','conflict');};
 if(!sourceRetired)fail('ORIGINAL_RETIREMENT_REQUIRED');if(!summary.sequence_valid||BigInt(summary.local_seq)<BigInt(receivedSeq))fail('RECOVERY_COUNTER_LOST');
 const ordered=[...operations].sort((a,b)=>BigInt(a.device_seq)<BigInt(b.device_seq)?-1:1);let previous=0n,alreadyReceived=0;
 for(const operation of ordered){const seq=BigInt(operation.device_seq);if(seq!==previous+1n)fail('RECOVERY_HISTORY_GAP');previous=seq;
  if(operation.acknowledged&&seq>BigInt(receivedSeq))fail('REMOTE_ROLLBACK_DETECTED');
  if(!operation.acknowledged&&seq<=BigInt(receivedSeq)){const r=await receipt(operation.operation_id);if(r.operation_id!==operation.operation_id||r.device_id!==summary.device_id||r.device_seq!==operation.device_seq||r.payload_hash!==operation.payload_hash||!['applied','duplicate'].includes(r.status)||!r.result)fail('RECOVERY_RECEIPT_MISMATCH');alreadyReceived++;}
 }
 if(previous!==BigInt(summary.local_seq))fail('RECOVERY_HISTORY_GAP');
 return {safe_to_activate:true,already_received:alreadyReceived,local_seq:summary.local_seq,remote_received_seq:receivedSeq,queue_action:'preserve_original_ids_and_replay_receipts' as const};
}
