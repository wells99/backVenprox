import { Value } from 'typebox/value';
import { ChangesResponse,ManifestResponse,SnapshotPageResponse } from '../../../contracts/src/download.js';
import { PushResponse,ReceiptResponse,DeviceStateResponse } from '../../../contracts/src/sync.js';
import { CompatibilitySchema } from '../../../contracts/src/system.js';
import type { PairedDevice } from '../../../application/src/local-auth.js';
import type { SyncGateway,ChangesPage } from '../../../application/src/sync-coordinator-ports.js';
import type { SnapshotManifest,SnapshotPage } from '../../../application/src/publication-ports.js';
import type { SyncReceipt } from '../../../application/src/sync-ports.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { TSchema } from '../../../contracts/src/common.js';
import { ReportAcceptedResponse } from '../../../contracts/src/reads.js';
export function syncHttpClient(origin:string,signal?:AbortSignal){
  const url=new URL(origin);if(url.origin!==origin||url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('INVALID_SYNC_ORIGIN');
  return async(path:string,device:PairedDevice,schema:TSchema,body?:unknown,session=false,headers:Record<string,string>={})=>{
    try{
      const response=await fetch(`${origin}${path}`,{method:body===undefined?'GET':'POST',redirect:'error',headers:{'x-device-credential':device.device_credential,...(body===undefined?{}:{'content-type':'application/json'}),...(session&&device.session?{cookie:device.session.cookies,origin,'x-csrf-token':device.session.csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
      if(response.headers.get('content-length')&&Number(response.headers.get('content-length'))>8*1024*1024)throw new Error('SYNC_RESPONSE_LIMIT');
      if(!response.body)throw new Error('SYNC_EMPTY_RESPONSE');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>8*1024*1024){await reader.cancel();throw new Error('SYNC_RESPONSE_LIMIT');}chunks.push(next.value);}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!response.ok){const raw=value&&typeof value==='object'&&'error'in value&&value.error&&typeof value.error==='object'&&'code'in value.error?String(value.error.code):'',code=/^[A-Z][A-Z0-9_]{0,99}$/.test(raw)?raw:'SYNC_REMOTE_FAILED';throw new ApplicationError(code,'Não foi possível concluir a operação de sincronização.',response.status===404?'not_found':response.status===401?'unauthenticated':response.status===403?'forbidden':response.status===409?'conflict':'unavailable',response.status>=500||response.status===429);}
      if(!Value.Check(schema,value))throw new ApplicationError('SYNC_REMOTE_CONTRACT_INVALID','Atualize o cliente para o contrato do servidor.','conflict');
      return value as {data:unknown};
    }catch(error){if(error instanceof ApplicationError)throw error;throw new ApplicationError('SYNC_REMOTE_UNAVAILABLE','Servidor de sincronização indisponível.','unavailable',true);}
  };
}
export function syncGateway(origin:string,signal?:AbortSignal):SyncGateway{
  const request=syncHttpClient(origin,signal);
  return {
    report:async(device,value)=>{await request('/api/v1/sync/status',device,ReportAcceptedResponse,value);},
    compatible:async(device)=>{const compatibility=await request('/api/v1/compatibility',device,CompatibilitySchema);const c=compatibility.data as {supported_protocol_versions:number[];minimum_app_version:string};if(!c.supported_protocol_versions.includes(1)||!/^0\.1\.[0-9]+$/.test(c.minimum_app_version)||c.minimum_app_version!=='0.1.0')throw new ApplicationError('SYNC_PROTOCOL_UPGRADE_REQUIRED','Protocolo ou aplicativo incompatível.','conflict');return (await request('/api/v1/sync/device-state',device,DeviceStateResponse)).data as Awaited<ReturnType<SyncGateway['compatible']>>;},
    changes:async(device,after)=>(await request(`/api/v1/sync/changes?after=${encodeURIComponent(after)}&limit=50`,device,ChangesResponse)).data as ChangesPage,
    push:async(device,value)=>{const data=(await request('/api/v1/sync/push',device,PushResponse,{items:[value]})).data as {items:SyncReceipt[]};if(data.items.length!==1)throw new ApplicationError('SYNC_RECEIPT_INVALID','Recibo individual ausente.','conflict');return data.items[0]!;},
    receipt:async(device,id)=>(await request(`/api/v1/sync/receipts/${id}`,device,ReceiptResponse)).data as SyncReceipt,
    snapshot:async(device)=>(await request('/api/v1/sync/snapshots',device,ManifestResponse,{kind:'initial'})).data as SnapshotManifest,
    manifest:async(device,id)=>(await request(`/api/v1/sync/snapshots/${id}`,device,ManifestResponse)).data as SnapshotManifest,
    page:async(device,id,page)=>(await request(`/api/v1/sync/snapshots/${id}/pages/${page}`,device,SnapshotPageResponse)).data as SnapshotPage,
  };
}
