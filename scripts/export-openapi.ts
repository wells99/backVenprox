import { mkdir, writeFile } from 'node:fs/promises';
import { buildApi } from '../apps/api/src/app.js';
import { createGetCompatibility } from '../packages/application/src/get-compatibility.js';
import { createCompatibilityPolicy } from '../packages/domain/src/compatibility.js';
import { createLogger } from '../packages/infrastructure/runtime/src/logger.js';
import { uuidGenerator } from '../packages/infrastructure/runtime/src/system.js';
import type { AuthHttpService } from '../apps/api/src/routes/auth.js';

// Só registra contratos; este script não abre servidor nem executa casos de uso.
const unavailable = (): never => { throw new Error('CONTRACT_EXPORT_ONLY'); };
const contractService: AuthHttpService = { authenticate:unavailable,activate:unavailable,login:unavailable,checkCsrf:unavailable,
  refresh:unavailable,logout:unavailable,me:unavailable,users:unavailable,createUser:unavailable,updateUser:unavailable,
  invitation:unavailable,enroll:unavailable,devices:unavailable,changeDevice:unavailable,offlineGrant:unavailable };

const app = buildApi({ logger: createLogger('openapi-export', 'silent'), ids: uuidGenerator,
  auth:{service:contractService,origin:'https://example.invalid',secureCookies:true,backups:{status:unavailable},reads:{sales:unavailable,sale:unavailable,reversals:unavailable,closure:unavailable,summary:unavailable,events:unavailable,terminals:unavailable,report:unavailable},resolutions:{get:unavailable,submit:unavailable},jobs:{requestCatalogExport:unavailable,get:unavailable,result:unavailable,retry:unavailable},sync:{push:unavailable,getReceipt:unavailable,deviceState:unavailable},download:{changes:unavailable,createSnapshot:unavailable,manifest:unavailable,page:unavailable},business:{
    catalog:{list:unavailable,get:unavailable,createCategory:unavailable,updateCategory:unavailable,createProduct:unavailable,updateProduct:unavailable,createCustomer:unavailable,updateCustomer:unavailable,settings:unavailable,changeSettings:unavailable},
    stock:{balances:unavailable,movements:unavailable},cash:{list:unavailable,get:unavailable,movements:unavailable}}},
  getCompatibility: createGetCompatibility(createCompatibilityPolicy('0.1.0', [1]), '0.1.0') });
try {
  await app.ready();
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/openapi.json', JSON.stringify(app.swagger(), null, 2));
  console.log('OpenAPI exportado para artifacts/openapi.json.');
} finally { await app.close(); }
