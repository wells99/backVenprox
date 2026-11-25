import { BusinessBase, businessError, businessConflict, versionConflict } from './business-base.js';
import type { BusinessContext, BusinessTransaction, Category, Customer, CustomerInput, CustomerPatch, Entity, EntityKind, Product, ProductInput, ProductPatch, SettingsPatch, StoreSettings } from './business-ports.js';
import { catalogSearchKey, catalogText, units, validMoney } from '../../domain/src/catalog-stock.js';
import { idCursor } from '../../domain/src/cursors.js';
import { ApplicationError } from './application-error.js';

export function publicEntity<T extends Entity>(value:T,context:BusinessContext) {
  const {store_id:_store,search_key:_search,...rest}:Record<string,unknown>={...value};
  if('code_key' in rest){const {code_key:_key,cost_cents,...product}=rest;return {...product,...(context.permissions.includes('costs.read')?{cost_cents}:{})};}
  return rest;
}
const text=(value:unknown,max=120)=>{const result=catalogText(value,max);if(result===undefined)throw businessError('INVALID_TEXT');return result;};
export class CatalogService extends BusinessBase {
  private productInput(input:ProductInput):ProductInput {
    const code=text(input.internal_code,64);text(code.toUpperCase(),64);
    if(!units.includes(input.unit)||!validMoney(input.price_cents)||(input.cost_cents!==undefined&&input.cost_cents!==null&&!validMoney(input.cost_cents)))throw businessError('INVALID_PRODUCT_VALUE');
    const barcodes=input.barcodes??[];
    if(barcodes.length>10||new Set(barcodes).size!==barcodes.length||barcodes.some((barcode)=>!/^[0-9]{1,64}$/.test(barcode)))throw businessError('INVALID_BARCODE');
    return {name:text(input.name),internal_code:code,unit:input.unit,price_cents:input.price_cents,barcodes,
      ...(input.cost_cents===undefined?{}:{cost_cents:input.cost_cents}),...(input.category_id===undefined?{}:{category_id:input.category_id}),...(input.active===undefined?{}:{active:input.active})};
  }
  private customerInput(input:CustomerInput):CustomerInput {
    const phone=input.phone===undefined?undefined:input.phone===null?null:text(input.phone,40);
    const email=input.email===undefined?undefined:input.email===null?null:text(input.email,254);
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw businessError('INVALID_EMAIL');
    return {name:text(input.name),...(phone===undefined?{}:{phone}),...(email===undefined?{}:{email}),...(input.active===undefined?{}:{active:input.active})};
  }
  private async constraints(tx:BusinessTransaction,product:Product,previous?:Product){
    if(product.category_id!==null&&product.category_id!==previous?.category_id){const category=await tx.business.category(product.category_id);if(!category?.active)throw businessConflict('CATEGORY_UNAVAILABLE','Categoria não encontrada ou inativa.');}
    const owner=await tx.business.codeOwner(product.code_key);if(owner&&owner!==product.id)throw businessConflict('PRODUCT_CODE_IN_USE','Código interno já utilizado.');
    for(const barcode of product.barcodes){const owner=await tx.business.barcodeOwner(barcode);if(owner&&owner!==product.id)throw businessConflict('BARCODE_IN_USE','Código de barras já utilizado.');}
    if(previous&&previous.unit!==product.unit&&(await tx.business.balance(product.id)).version>0)throw businessConflict('UNIT_HAS_MOVEMENTS','A unidade de um produto com movimentos não pode ser alterada.');
  }
  private async entity(tx:BusinessTransaction,kind:EntityKind,id:string):Promise<Entity>{
    const value=kind==='products'?await tx.business.product(id):kind==='categories'?await tx.business.category(id):await tx.business.customer(id);
    if(!value)throw new ApplicationError('ENTITY_NOT_FOUND','Cadastro não encontrado.','not_found');return value;
  }
  async list(context:BusinessContext,kind:EntityKind,query:{q?:string;after?:string;limit?:number;active?:boolean}={}){
    this.authorize(context,'catalog.read');const page=this.pageQuery(query);
    return this.transaction(async(tx)=>{const rows=await tx.business.page(kind,page);const items=rows.slice(0,page.limit);
      return {items:items.map((value)=>publicEntity(value,context)),next_cursor:rows.length>page.limit?idCursor(items.at(-1)!.id):null,scope:this.scope(),as_of:this.now()};});
  }
  async get(context:BusinessContext,kind:EntityKind,id:string){this.authorize(context,'catalog.read');return this.transaction(async(tx)=>publicEntity(await this.entity(tx,kind,id),context));}
  async createCategory(context:BusinessContext,intention:string,input:{name:string;active?:boolean}){
    this.authorize(context,'catalog.write');this.writesAllowed();if(this.deps.local)throw businessError('LOCAL_CATEGORY_CREATION_NOT_SUPPORTED');
    const name=text(input.name),id=this.deps.ids.generate();
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'category.create',name,active:input.active??true},async()=>{
      const category:Category={id,store_id:this.deps.storeId,name,search_key:catalogSearchKey(name),active:input.active??true,version:1};
      await tx.business.saveCategory(category);await this.event(tx,context,intention,'category.created.v1',{category});return category;}));return publicEntity(result,context);
  }
  async updateCategory(context:BusinessContext,id:string,intention:string,version:number,patch:{name?:string;active?:boolean}){
    this.authorize(context,'catalog.write');this.writesAllowed();
    const normalized={...(patch.name===undefined?{}:{name:text(patch.name)}),...(patch.active===undefined?{}:{active:patch.active})};
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'category.update',id,version,patch:normalized},async()=>{
      const base=await this.entity(tx,'categories',id) as Category;if(base.version!==version&&!this.deps.local)throw versionConflict(base.version,version);
      const value={...base,...normalized,search_key:catalogSearchKey(normalized.name??base.name),version:version+1};
      if(this.deps.local)return this.propose(tx,context,intention,'categories',id,base,value,version);
      await tx.business.saveCategory(value);await this.event(tx,context,intention,'category.updated.v1',{base_version:version,category:value});return value;
    }));return this.projectResult(result,context);
  }
  async createProduct(context:BusinessContext,intention:string,input:ProductInput){
    this.authorize(context,'catalog.write');this.writesAllowed();const normalized=this.productInput(input);
    if(input.cost_cents!==undefined&&!context.permissions.includes('costs.read'))throw new ApplicationError('PERMISSION_DENIED','Permissão insuficiente para custo.','forbidden');
    const id=this.deps.ids.generate();
    const result=await this.transaction((tx)=>this.replay(tx,context,intention,{kind:'product.create',input:normalized},async()=>{
      const value:Product={id,store_id:this.deps.storeId,name:normalized.name,search_key:catalogSearchKey(normalized.name),internal_code:normalized.internal_code,
        code_key:normalized.internal_code.toUpperCase(),unit:normalized.unit,price_cents:normalized.price_cents,cost_cents:normalized.cost_cents??null,category_id:normalized.category_id??null,active:normalized.active??true,version:1,barcodes:normalized.barcodes??[]};
      await this.constraints(tx,value);
      if(this.deps.local)return this.propose(tx,context,intention,'products',id,null,value);
      await tx.business.saveProduct(value);await this.event(tx,context,intention,'product.created.v1',{product:value});return value;
    }));return this.projectResult(result,context);
  }
  async updateProduct(context:BusinessContext,id:string,intention:string,version:number,patch:ProductPatch){
    this.authorize(context,'catalog.write');this.writesAllowed();
    if(patch.cost_cents!==undefined&&!context.permissions.includes('costs.read'))throw new ApplicationError('PERMISSION_DENIED','Permissão insuficiente para custo.','forbidden');
    return this.transaction(async(tx)=>{
      const raw=await this.replay(tx,context,intention,{kind:'product.update',id,version,patch},async()=>{
        const base=await this.entity(tx,'products',id) as Product;if(base.version!==version&&!this.deps.local)throw versionConflict(base.version,version);
        const normalized=this.productInput({...base,...patch});
        const value:Product={...base,...normalized,cost_cents:normalized.cost_cents??null,category_id:normalized.category_id??null,barcodes:normalized.barcodes??[],code_key:normalized.internal_code.toUpperCase(),search_key:catalogSearchKey(normalized.name),version:version+1};
        await this.constraints(tx,value,base);
        if(this.deps.local)return this.propose(tx,context,intention,'products',id,base,value,version);
        await tx.business.saveProduct(value);await this.event(tx,context,intention,'product.updated.v1',{base_version:version,product:value});return value;
      });return this.projectResult(raw,context);
    });
  }
  async createCustomer(context:BusinessContext,intention:string,input:CustomerInput,localId?:string){
    this.authorize(context,this.deps.local?'sales.create':'catalog.write');this.writesAllowed();const normalized=this.customerInput(input),id=localId??this.deps.ids.generate();
    return this.transaction(async(tx)=>{
      const result=await this.replay(tx,context,intention,{kind:'customer.create',input:normalized,...(localId?{local_id:localId}:{})},async()=>{
        if(await tx.business.customer(id))throw businessConflict('ENTITY_ID_IN_USE');
        const value:Customer={id,store_id:this.deps.storeId,name:normalized.name,search_key:catalogSearchKey(normalized.name),phone:normalized.phone??null,email:normalized.email??null,active:normalized.active??true,version:1,confirmation_state:this.deps.local?'local_pending':'confirmed'};
        await tx.business.saveCustomer(value);
        if(this.deps.local)return this.propose(tx,context,intention,'customers',id,null,value);
        await this.event(tx,context,intention,'customer.created.v1',{customer:value});return value;
      });return this.projectResult(result,context);
    });
  }
  async updateCustomer(context:BusinessContext,id:string,intention:string,version:number,patch:CustomerPatch){
    this.authorize(context,'catalog.write');this.writesAllowed();
    return this.transaction(async(tx)=>{
      const raw=await this.replay(tx,context,intention,{kind:'customer.update',id,version,patch},async()=>{
        const base=await this.entity(tx,'customers',id) as Customer;if(base.version!==version&&!this.deps.local)throw versionConflict(base.version,version);
        const normalized=this.customerInput({...base,...patch}),value:Customer={...base,...normalized,phone:normalized.phone??null,email:normalized.email??null,search_key:catalogSearchKey(normalized.name),version:version+1};
        if(this.deps.local)return this.propose(tx,context,intention,'customers',id,base,value,version);
        await tx.business.saveCustomer(value);await this.event(tx,context,intention,'customer.updated.v1',{base_version:version,customer:value});return value;
      });return this.projectResult(raw,context);
    });
  }
  private async propose(tx:BusinessTransaction,context:BusinessContext,intention:string,kind:EntityKind|'settings',id:string,base:Entity|StoreSettings|null,value:Entity|StoreSettings,expectedVersion=base?.version??0){
    const status=expectedVersion===(base?.version??0)?'pending' as const:'conflict' as const;
    const proposal={intention_id:intention,store_id:this.deps.storeId,entity_type:kind,entity_id:id,base_version:expectedVersion,status,base_json:JSON.stringify(base),proposal_json:JSON.stringify(value),actor_id:context.user_id};
    await tx.business.saveProposal(proposal);await this.event(tx,context,intention,`${kind}.proposal${status==='conflict'?'.conflict':''}.v1`,{entity_type:kind,entity_id:id,base_version:expectedVersion,proposal:value});
    return {intention_id:intention,entity_type:kind,entity_id:id,base_version:expectedVersion,status,base,proposal:value};
  }
  private projectResult(value:unknown,context:BusinessContext):unknown {
    if(value&&typeof value==='object'&&'proposal' in value&&'base' in value){const item=value as {proposal:Entity|StoreSettings;base:Entity|StoreSettings|null};return {...value,base:item.base?this.projectResult(item.base,context):null,proposal:this.projectResult(item.proposal,context)};}
    if(value&&typeof value==='object'&&'search_key' in value)return publicEntity(value as Entity,context);
    if(value&&typeof value==='object'&&'store_id' in value){const {store_id:_store,...rest}=value;return rest;}
    return value;
  }
  async pending(context:BusinessContext,kind?:EntityKind|'settings'){
    this.authorize(context,'catalog.read');if(!this.deps.local)return {items:[]};
    return this.transaction(async(tx)=>({items:(await tx.business.proposals(kind)).map((item)=>this.projectResult({intention_id:item.intention_id,entity_type:item.entity_type,entity_id:item.entity_id,base_version:item.base_version,status:item.status,base:JSON.parse(item.base_json),proposal:JSON.parse(item.proposal_json)},context))}));
  }
  async settings(context:BusinessContext){this.authorize(context,'catalog.read');return this.transaction(async(tx)=>{
    const {store_id:_store,...store}=await tx.business.settings();
    return {store,...(this.deps.local?{terminal:await tx.business.terminalSettings(this.deps.deviceId)}:{}),scope:this.scope()};
  });}
  async changeSettings(context:BusinessContext,intention:string,version:number,patch:SettingsPatch){
    this.authorize(context,'settings.manage');this.writesAllowed();
    if(patch.stock_policy==='require_stock'&&patch.strict_scope!=='local_terminal')throw businessError('STRICT_SCOPE_ACKNOWLEDGEMENT_REQUIRED','Confirme explicitamente que a garantia estrita é apenas local.');
    if(patch.images_enabled!==undefined&&patch.images_enabled!==false)throw businessError('IMAGES_NOT_IMPLEMENTED');
    if(patch.stock_policy!==undefined&&!['permissive','require_stock'].includes(patch.stock_policy))throw businessError('INVALID_STOCK_POLICY');
    return this.transaction(async(tx)=>{
      const result=await this.replay(tx,context,intention,{kind:'settings.change',version,patch},async()=>{
        const base=await tx.business.settings();if(base.version!==version&&!this.deps.local)throw versionConflict(base.version,version);
        const value={...base,...patch,version:version+1};
        if(this.deps.local)return this.propose(tx,context,intention,'settings',base.id,base,value,version);
        await tx.business.saveSettings(value);await this.event(tx,context,intention,'settings.updated.v1',{base_version:version,settings:value});return value;
      });return this.projectResult(result,context);
    });
  }
  async changeTerminalSettings(context:BusinessContext,intention:string,version:number,printing:false){
    this.authorize(context,'settings.manage');if(!this.deps.local||printing!==false)throw businessError('PRINTING_NOT_IMPLEMENTED');
    return this.transaction((tx)=>this.replay(tx,context,intention,{kind:'terminal.settings',version,printing},async()=>{
      const base=await tx.business.terminalSettings(this.deps.deviceId);if(base.version!==version)throw businessConflict('VERSION_CONFLICT');
      const value={...base,version:version+1,automatic_printing:printing};await tx.business.saveTerminalSettings(value);await this.event(tx,context,intention,'terminal.settings.updated.v1',{settings:value});return value;
    }));
  }
}
