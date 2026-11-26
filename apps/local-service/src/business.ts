import type { CatalogService } from '../../../packages/application/src/catalog-service.js';
import type { StockService } from '../../../packages/application/src/stock-service.js';
import type { CashService } from '../../../packages/application/src/cash-service.js';
import type { SalesService } from '../../../packages/application/src/sales-service.js';
import type { ReversalService } from '../../../packages/application/src/reversal-service.js';
import type { ClosureService } from '../../../packages/application/src/closure-service.js';
import type { BusinessContext } from '../../../packages/application/src/business-ports.js';
import type { BusinessIpcCommand } from '../../../packages/contracts/src/catalog-stock.js';
export async function executeBusiness(message:BusinessIpcCommand,context:BusinessContext,catalog:CatalogService,stock:StockService,cash?:CashService,sales?:SalesService,reversal?:ReversalService,closure?:ClosureService):Promise<unknown>{
  switch(message.type){
    case 'sales.reverse':return reversal!.reverse(context,message.intention_id,message.input);
    case 'cash.previewClose':return closure!.preview(context,message.session_id);
    case 'cash.close':return closure!.close(context,message.intention_id,message.input);
    case 'cash.getClosure':return closure!.get(context,message.session_id);
    case 'sales.createDraft':return sales!.createDraft(context,message.intention_id,message.sale_id,message.input);
    case 'sales.getDraft':return sales!.getDraft(context,message.sale_id);
    case 'sales.updateDraft':return sales!.updateDraft(context,message.intention_id,message.sale_id,message.expected_version,message.input);
    case 'sales.complete':return sales!.complete(context,message.intention_id,message.input);
    case 'sales.getCompletionResult':return sales!.getCompletionResult(context,message.intention_id);
    case 'cash.getCurrent':return cash!.current(context);
    case 'cash.listSessions':return cash!.list(context,message.query);
    case 'cash.getSession':return cash!.get(context,message.id);
    case 'cash.getMovements':return cash!.movements(context,message.id,message.query);
    case 'cash.open':return cash!.open(context,message.intention_id,message.input);
    case 'cash.registerSupply':return cash!.register(context,message.intention_id,'supply',message.input);
    case 'cash.registerWithdrawal':return cash!.register(context,message.intention_id,'withdrawal',message.input);
    case 'catalog.search':return catalog.list(context,message.entity_type,message.query);
    case 'catalog.get':return catalog.get(context,message.entity_type,message.id);
    case 'catalog.getPending':return catalog.pending(context,message.entity_type);
    case 'products.proposeCreate':return catalog.createProduct(context,message.intention_id,message.input);
    case 'products.proposeUpdate':{const {expected_version,...patch}=message.input;return catalog.updateProduct(context,message.id,message.intention_id,expected_version,patch);}
    case 'categories.proposeUpdate':{const {expected_version,...patch}=message.input;return catalog.updateCategory(context,message.id,message.intention_id,expected_version,patch);}
    case 'customers.createMinimal':return catalog.createCustomer(context,message.intention_id,message.input,message.id);
    case 'customers.proposeUpdate':{const {expected_version,...patch}=message.input;return catalog.updateCustomer(context,message.id,message.intention_id,expected_version,patch);}
    case 'settings.get':return catalog.settings(context);
    case 'settings.change':{const {expected_version,...patch}=message.input;return catalog.changeSettings(context,message.intention_id,expected_version,patch);}
    case 'settings.changeTerminal':return catalog.changeTerminalSettings(context,message.intention_id,message.expected_version,message.automatic_printing);
    case 'stock.getBalances':return stock.balances(context,message.query);
    case 'stock.getMovements':return stock.movements(context,message.query);
    case 'stock.registerEntry':return stock.registerEntry(context,message.intention_id,message.input);
    case 'stock.adjustCount':return stock.adjustCount(context,message.intention_id,message.input);
    case 'stock.rebuildProjection':return stock.rebuild(context,message.intention_id,message.product_id);
  }
}
