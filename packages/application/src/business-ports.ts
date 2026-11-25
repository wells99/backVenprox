import type { AuthorizedContext } from '../../domain/src/authorization.js';
import type { StockPolicy, Unit } from '../../domain/src/catalog-stock.js';
import type { PersistenceRepositories } from './persistence.js';
import type { Clock, IdGenerator, UnitOfWork } from './ports.js';
import type { CashRepository } from './cash-ports.js';
import type { SalesRepository } from './sales-ports.js';
import type { ReversalRepository } from './reversal-ports.js';

export interface Category {id:string;store_id:string;name:string;search_key:string;active:boolean;version:number}
export interface Product {id:string;store_id:string;name:string;search_key:string;internal_code:string;code_key:string;unit:Unit;price_cents:number;cost_cents:number|null;category_id:string|null;active:boolean;version:number;barcodes:string[]}
export interface Customer {id:string;store_id:string;name:string;search_key:string;phone:string|null;email:string|null;active:boolean;version:number;confirmation_state:'confirmed'|'local_pending'}
export interface StoreSettings {id:string;store_id:string;version:number;stock_policy:StockPolicy;strict_scope:'local_terminal';images_enabled:false}
export interface TerminalSettings {store_id:string;device_id:string;version:number;automatic_printing:false}
export type EntityKind='categories'|'products'|'customers';
export type Entity=Category|Product|Customer;
export interface PageQuery {q?:string;code_q?:string;after?:string;limit:number;active?:boolean}
export interface Proposal {intention_id:string;store_id:string;entity_type:EntityKind|'settings';entity_id:string;base_version:number;status:'pending'|'conflict';base_json:string;proposal_json:string;actor_id:string}
export interface Intention {intention_id:string;store_id:string;actor_id:string;command_hash:string;result_json:string}
export interface StockBalance {store_id:string;product_id:string;quantity_milli:number;version:number}
export interface StockMovement {id:string;store_id:string;product_id:string;device_id:string;operator_id:string;kind:'entry'|'opening'|'adjustment'|'sale'|'reversal';origin_id:string;item_id:string;delta_milli:number;before_milli:number;after_milli:number;unit:Unit;unit_cost_cents:number|null;reason:string;occurred_at:string;authorization_context:string}
export interface MovementQuery {product_id?:string;from?:string;to?:string;after_at?:string;after_id?:string;limit:number}
export interface BusinessRepository extends CashRepository, SalesRepository, ReversalRepository {
  lockScope():Promise<void>;
  category(id:string):Promise<Category|undefined>;saveCategory(value:Category):Promise<void>;
  product(id:string):Promise<Product|undefined>;saveProduct(value:Product):Promise<void>;codeOwner(key:string):Promise<string|undefined>;barcodeOwner(barcode:string):Promise<string|undefined>;
  customer(id:string):Promise<Customer|undefined>;saveCustomer(value:Customer):Promise<void>;
  page(kind:EntityKind,query:PageQuery):Promise<Entity[]>;
  settings():Promise<StoreSettings>;saveSettings(value:StoreSettings):Promise<void>;
  terminalSettings(deviceId:string):Promise<TerminalSettings>;saveTerminalSettings(value:TerminalSettings):Promise<void>;
  intention(id:string):Promise<Intention|undefined>;saveIntention(value:Intention):Promise<void>;
  proposal(id:string):Promise<Proposal|undefined>;saveProposal(value:Proposal):Promise<void>;proposals(kind?:EntityKind|'settings'):Promise<Proposal[]>;
  balance(productId:string):Promise<StockBalance>;saveBalance(value:StockBalance):Promise<void>;
  movements(query:MovementQuery):Promise<StockMovement[]>;movementByOrigin(originId:string,kind:StockMovement['kind'],itemId:string):Promise<StockMovement|undefined>;
  appendMovement(value:StockMovement):Promise<void>;ledgerSum(productId:string):Promise<string>;
}
export interface BusinessTransaction extends PersistenceRepositories { business:BusinessRepository }
export interface BusinessDependencies {unitOfWork:UnitOfWork<BusinessTransaction>;storeId:string;deviceId:string;local:boolean;clock:Clock;ids:IdGenerator;hash:(value:unknown)=>string;remoteWritesEnabled:boolean}
export type ProductInput={name:string;internal_code:string;unit:Unit;price_cents:number;cost_cents?:number|null;category_id?:string|null;barcodes?:string[];active?:boolean};
export type ProductPatch=Partial<ProductInput>;
export type CustomerInput={name:string;phone?:string|null;email?:string|null;active?:boolean};
export type CustomerPatch=Partial<CustomerInput>;
export type SettingsPatch={stock_policy?:StockPolicy;strict_scope?:'local_terminal';images_enabled?:false};
export type BusinessContext=AuthorizedContext;
