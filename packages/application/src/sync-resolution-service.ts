import { ApplicationError } from './application-error.js';
import { SyncRejection,type SyncEnvelope,type SyncReceipt } from './sync-ports.js';
import type { ResolutionDependencies,ResolutionCommand,ResolutionResult,ResolutionTransaction } from './sync-resolution-ports.js';
import type { BusinessContext,ProductInput,CustomerInput,SettingsPatch } from './business-ports.js';
import { CatalogService } from './catalog-service.js';
import { SyncService } from './sync-service.js';
import { SyncHandlers } from './sync-handlers.js';
import { catalogText } from '../../domain/src/catalog-stock.js';
const problem=(code:string)=>new ApplicationError(code,'A resolução não pode ser aplicada ao estado atual; preserve o original e confira as dependências.','conflict');
export class SyncResolutionService {
  private readonly auditDevice:string;
  constructor(readonly deps:ResolutionDependencies){this.auditDevice=deps.ids.generate();}
  private authorize(c:BusinessContext){const at=this.deps.clock.now().toISOString();if(c.store_id!==this.deps.storeId||c.authorization_origin!=='online'||!c.permissions.includes('recovery.manage')||!c.permissions.includes('users.manage'))throw new ApplicationError('PERMISSION_DENIED','Revisão administrativa online necessária.','forbidden');if(c.expires_at<=at||c.authorized_at>at)throw new ApplicationError('AUTHENTICATION_REQUIRED','Renove a autenticação.','unauthenticated');}
  async get(c:BusinessContext,id:string){this.authorize(c);return this.deps.unitOfWork.run(async(tx)=>{await tx.business.lockScope();const row=await tx.resolutions.byId(id);if(!row)throw new ApplicationError('SYNC_RESOLUTION_NOT_FOUND','Resolução não encontrada.','not_found');return JSON.parse(row.result_json) as ResolutionResult;});}
  async submit(c:BusinessContext,id:string,command:ResolutionCommand){
    this.authorize(c);const reason=catalogText(command.reason,500,true);if(!reason||command.expected_version!==1)throw problem('SYNC_RESOLUTION_VERSION_CONFLICT');
    const hash=this.deps.hashValue({...command,reason,actor:c.user_id});
    return this.deps.unitOfWork.run(async(tx)=>{
      await tx.business.lockScope();const prior=await tx.resolutions.byId(id);if(prior){if(prior.actor_id!==c.user_id||prior.command_hash!==hash)throw problem('IDEMPOTENCY_CONFLICT');return JSON.parse(prior.result_json) as ResolutionResult;}
      if(await tx.resolutions.byOperation(command.operation_id))throw problem('SYNC_RESOLUTION_VERSION_CONFLICT');
      const original=await tx.sync.inbox(command.operation_id);if(!original)throw new ApplicationError('RECEIPT_NOT_FOUND','Operação original ainda não recebida.','not_found');
      const e=JSON.parse(original.envelope_json) as SyncEnvelope;
      if(e.store_id!==this.deps.storeId||e.device_id!==original.device_id||e.operation_id!==original.operation_id||this.deps.hashEnvelope(e)!==original.envelope_hash||this.deps.hashEnvelope(e)!==e.payload_hash||e.payload_hash!==original.payload_hash)throw problem('SYNC_RESOLUTION_ENVELOPE_INVALID');
      const deviceCode=await tx.resolutions.deviceCode(e.device_id);if(!deviceCode)throw problem('SYNC_ORIGIN_MISSING');
      const at=this.deps.clock.now().toISOString(),proposal=/^(products|categories|customers|settings)\.proposal(?:\.conflict)?\.v1$/.test(e.type)||e.type==='terminal.settings.updated.v1';
      const originalReceipt=JSON.parse(original.receipt_json) as SyncReceipt;let receipt=originalReceipt,outcome:ResolutionResult['outcome']='confirmed';
      if(['confirm_original','retry_original'].includes(command.action)){
        if(proposal||original.state==='applied'||original.state==='processing')throw problem('SYNC_RESOLUTION_ACTION_INVALID');
        if(e.protocol_version!==1||e.payload_version!==1||!this.deps.validatePayload(e.type,e.payload_version,e.payload))throw problem('SYNC_RESOLUTION_PAYLOAD_INVALID');
        if(BigInt(e.device_seq)!==BigInt(await tx.sync.frontier(e.device_id))+1n)throw problem('SEQUENCE_GAP');
        for(const dependency of e.dependencies)if((await tx.sync.inbox(dependency))?.state!=='applied')throw problem('DEPENDENCY_MISSING');
        try{await new SyncService(this.deps).validateOrigin(tx,e);}catch(error){if(!(command.action==='confirm_original'&&error instanceof SyncRejection&&error.code==='ORIGIN_AUTHORIZATION_UNPROVEN'))throw problem(error instanceof SyncRejection?error.code:'SYNC_ORIGIN_INVALID');}
        try{const result=await new SyncHandlers(this.deps).apply(tx,e,deviceCode);await this.deps.publication.publish(tx,e,result);receipt={...originalReceipt,status:'applied',code:'APPLIED_BY_RESOLUTION',result};}
        catch(error){if(error instanceof SyncRejection)throw problem(error.code);throw error;}
        await tx.sync.finishInbox(e.operation_id,'applied',JSON.stringify(receipt));await tx.sync.advance(e.device_id,e.device_seq);
        await tx.audit.append({operation_id:e.operation_id,store_id:e.store_id,device_id:e.device_id,occurred_at:e.occurred_at_device,action:e.type,actor_user_id:e.origin_authorization.context.user_id,permissions_version:e.origin_authorization.context.permissions_version,authorization_origin:e.origin_authorization.context.authorization_origin,authorization_id:e.origin_authorization.context.authorization_id});
        await tx.publication!.publish({operation_id:id,type:'sync.resolution.confirmed.v1',source:'web',payload:{operation_id:e.operation_id,resolution_id:id,device_id:e.device_id},published_at:at});
      }else{
        if(!proposal)throw problem('SYNC_FINANCIAL_DISCARD_FORBIDDEN');
        if(original.state!=='applied')for(const dependency of e.dependencies)if((await tx.sync.inbox(dependency))?.state!=='applied')throw problem('DEPENDENCY_MISSING');
        outcome=command.action==='reject_proposal'?'rejected':'accepted';
        const meta={operation_id:e.operation_id,resolution_id:id,outcome};let published=false;
        if(outcome==='accepted'){
          if(!c.permissions.includes('catalog.write')&&e.type!=='terminal.settings.updated.v1')throw new ApplicationError('PERMISSION_DENIED','Permissão de cadastro necessária.','forbidden');
          if(!this.deps.validatePayload(e.type,e.payload_version,e.payload))throw problem('SYNC_RESOLUTION_PAYLOAD_INVALID');
          published=await this.applyProposal(tx,c,id,e,command,meta);
        }else if(e.type.startsWith('customers.proposal')){const p=e.payload as {base_version:number;entity_id:string};if(p.base_version===0&&await tx.business.customer(p.entity_id))throw problem('CUSTOMER_ALREADY_CONFIRMED');}
        if(!published)await tx.publication!.publish({operation_id:id,type:'sync.proposal.resolved.v1',source:'web',payload:meta,published_at:at,projection:{stock_deltas:[],proposal_outcome:meta}});
        if(original.state!=='applied'){
          if(BigInt(e.device_seq)!==BigInt(await tx.sync.frontier(e.device_id))+1n)throw problem('SEQUENCE_GAP');
          receipt={...originalReceipt,status:'applied',code:'RESOLVED_WITHOUT_EFFECT',result:{entity_id:null,received_at:at,reconciliation:'not_applicable'}};
          await tx.sync.finishInbox(e.operation_id,'applied',JSON.stringify(receipt));await tx.sync.advance(e.device_id,e.device_seq);
        }
      }
      const result:ResolutionResult={id,operation_id:e.operation_id,device_id:e.device_id,action:command.action,version:2,receipt,outcome,created_at:at};
      await tx.resolutions.insert({id,store_id:this.deps.storeId,operation_id:e.operation_id,actor_id:c.user_id,command_hash:hash,action:command.action,reason,original_receipt_json:original.receipt_json,result_json:JSON.stringify(result),created_at:at});
      await tx.audit.append({operation_id:id,store_id:this.deps.storeId,device_id:this.auditDevice,occurred_at:at,action:'sync.resolution.recorded',actor_user_id:c.user_id,permissions_version:c.permissions_version,authorization_origin:c.authorization_origin,authorization_id:c.authorization_id});return result;
    });
  }
  private async applyProposal(tx:ResolutionTransaction,c:BusinessContext,id:string,e:SyncEnvelope,command:ResolutionCommand,meta:{operation_id:string;resolution_id:string;outcome:'accepted'|'rejected'}){
    if(e.type==='terminal.settings.updated.v1')return false;
    const p=e.payload as {entity_type:'products'|'categories'|'customers'|'settings';entity_id:string;base_version:number;proposal:Record<string,unknown>};let v=p.proposal;
    if(v.store_id!==this.deps.storeId||v.id!==p.entity_id||v.version!==p.base_version+1)throw problem('SYNC_RESOLUTION_PAYLOAD_INVALID');
    const current=p.entity_type==='products'?await tx.business.product(p.entity_id):p.entity_type==='categories'?await tx.business.category(p.entity_id):p.entity_type==='customers'?await tx.business.customer(p.entity_id):await tx.business.settings();
    if(p.entity_type==='customers'&&p.base_version===0&&current)return false;
    const version=current?.version??0,expected=command.action==='reapply_proposal'?command.expected_entity_version:p.base_version;if(expected===undefined||expected!==version)throw problem('CATALOG_VERSION_CONFLICT');
    if(command.action==='reapply_proposal'){
      const fields=p.entity_type==='products'?['name','internal_code','unit','price_cents','cost_cents','category_id','barcodes','active']:p.entity_type==='categories'?['name','active']:p.entity_type==='customers'?['name','phone','email','active']:['stock_policy','strict_scope','images_enabled'];
      if(!current||!command.patch||!Object.keys(command.patch).length||Object.keys(command.patch).some((k)=>!fields.includes(k)))throw problem('SYNC_RESOLUTION_PATCH_REQUIRED');
      v={...current,...command.patch};
    }
    const publication={publish:async(value:Parameters<NonNullable<typeof tx.publication>['publish']>[0])=>tx.publication!.publish({...value,projection:{stock_deltas:[],proposal_outcome:meta}})};
    const service=new CatalogService({unitOfWork:{run:(work)=>work({...tx,publication})},storeId:this.deps.storeId,deviceId:this.auditDevice,local:false,clock:this.deps.clock,ids:{generate:()=>p.entity_id},hash:this.deps.hashValue,remoteWritesEnabled:true});
    if(p.entity_type==='products'){
      const input:ProductInput={name:String(v.name),internal_code:String(v.internal_code),unit:v.unit as ProductInput['unit'],price_cents:Number(v.price_cents),cost_cents:v.cost_cents===null?null:Number(v.cost_cents),category_id:v.category_id as string|null,barcodes:v.barcodes as string[],active:v.active as boolean};
      if(current)await service.updateProduct(c,p.entity_id,id,version,input);else await service.createProduct(c,id,input);
    }else if(p.entity_type==='categories'){const input={name:String(v.name),active:v.active as boolean};if(current)await service.updateCategory(c,p.entity_id,id,version,input);else await service.createCategory(c,id,input);}
    else if(p.entity_type==='customers'){const input:CustomerInput={name:String(v.name),phone:v.phone as string|null,email:v.email as string|null,active:v.active as boolean};if(current)await service.updateCustomer(c,p.entity_id,id,version,input);else await service.createCustomer(c,id,input,p.entity_id);}
    else await service.changeSettings(c,id,version,{stock_policy:v.stock_policy,strict_scope:v.strict_scope,images_enabled:v.images_enabled} as SettingsPatch);
    return true;
  }
}
