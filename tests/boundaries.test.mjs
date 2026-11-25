import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedImport, checkBoundaries, inspectImports } from '../scripts/check-boundaries.mjs';

test('domínio/aplicação/transportes recusam dependências que pulam camadas', () => {
  assert.equal(allowedImport('packages/domain/src/rule.ts', 'fastify'), false);
  assert.equal(allowedImport('packages/domain/src/rule.ts', '../../application/src/ports.js'), false);
  assert.equal(allowedImport('packages/application/src/use-case.ts', 'mysql2/promise'), false);
  assert.equal(allowedImport('packages/application/src/use-case.ts', '../../infrastructure/sqlite/src/runtime-diagnostics.js'), false);
  assert.equal(allowedImport('apps/api/src/routes/sales.ts', '../../../../packages/infrastructure/mysql/src/probe.js'), false);
  assert.equal(allowedImport('apps/api/src/routes/sales.ts', '../../../../packages/application/src/ports.js'), true);
  assert.equal(allowedImport('packages/contracts/src/system.ts', 'node:fs'), false);
  assert.equal(allowedImport('packages/infrastructure/mysql/src/repository.ts', '../../sqlite/src/runtime-diagnostics.js'), false);
});

test('análise por AST cobre importação multilinha, tipos, reexports e importação dinâmica', () => {
  const inspected = inspectImports('module.ts', `
    // import fake from 'ignored';
    import type {
      Repository,
    } from 'forbidden-driver';
    export { value } from './value.js';
    const text = "import ignored from 'also-ignored'";
  `);
  assert.deepEqual(inspected.specifiers, ['forbidden-driver', './value.js']);
  assert.equal(inspected.hasForbiddenForm, false);
  assert.equal(inspectImports('module.ts', 'const value = import(name)').hasForbiddenForm, true);
  assert.equal(inspectImports('module.ts', 'const value = require(name)').hasForbiddenForm, true);
});

test('todos os módulos atuais respeitam as fronteiras', async () => {
  assert.ok(await checkBoundaries() > 0);
});
