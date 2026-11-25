import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = (value) => value.replaceAll('\\', '/');

export function classify(path) {
  const value = normalize(path);
  if (value.startsWith('migrations/')) return 'infrastructure';
  if (value.startsWith('packages/domain/')) return 'domain';
  if (value.startsWith('packages/application/')) return 'application';
  if (value.startsWith('packages/contracts/')) return 'contracts';
  if (value.startsWith('packages/infrastructure/')) return 'infrastructure';
  if (value.startsWith('apps/') && value.endsWith('/main.ts')) return 'composition';
  if (value.startsWith('apps/')) return 'transport';
  return 'unknown';
}

export function allowedImport(sourcePath, specifier) {
  const source = classify(sourcePath);
  if (!specifier.startsWith('.')) {
    if (/^(?:[a-zA-Z]:|\/|#)/.test(specifier)) return false;
    if (source === 'domain' || source === 'application') return false;
    if (source === 'contracts') return specifier === 'typebox' || specifier.startsWith('typebox/');
    if (source === 'transport') return ['fastify', 'pino', '@fastify/type-provider-typebox', '@fastify/swagger', '@fastify/swagger-ui', '@fastify/cookie'].includes(specifier);
    if (source === 'infrastructure') {
      const adapter = normalize(sourcePath).split('/')[2];
      return specifier.startsWith('node:') || ({
        runtime: ['pino','mysql2/promise'], sqlite: ['better-sqlite3'], mysql: ['mysql2/promise'], security: ['argon2','typebox/value'], native: ['typebox/value'],
      })[adapter]?.includes(specifier) === true;
    }
    return source === 'composition';
  }
  const targetPath = normalize(relative(root, resolve(root, dirname(sourcePath), specifier))).replace(/\.js$/, '.ts');
  if (targetPath.startsWith('../')) return false;
  const target = classify(targetPath);
  const allowed = {
    domain: ['domain'],
    application: ['application', 'domain'],
    contracts: ['contracts'],
    infrastructure: ['infrastructure', 'application', 'domain', 'contracts'],
    composition: ['composition', 'transport', 'infrastructure', 'application', 'domain', 'contracts'],
    transport: ['transport', 'application', 'contracts'],
  };
  if (!allowed[source]?.includes(target)) return false;
  if (source === 'infrastructure' && target === 'infrastructure') {
    // O worker remoto não puxa SQLite por uma importação indireta do MySQL.
    const adapter = normalize(sourcePath).split('/')[2];
    const targetAdapter = targetPath.split('/')[2];
    if ((adapter === 'mysql' && targetAdapter === 'sqlite') ||
        (adapter === 'sqlite' && targetAdapter === 'mysql')) return false;
  }
  return true;
}

export function inspectImports(sourcePath, content) {
  const parsed = parseSync(sourcePath, content);
  if (parsed.errors.length) throw new Error(`${sourcePath}: não foi possível analisar o TypeScript.`);
  const specifiers = [];
  let hasForbiddenForm = false;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      specifiers.push(node.source.value);
    }
    if (['ImportExpression', 'TSImportEqualsDeclaration', 'TSImportType'].includes(node.type) ||
        (node.type === 'CallExpression' && node.callee?.name === 'require')) hasForbiddenForm = true;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(parsed.program);
  return { specifiers, hasForbiddenForm };
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  }));
  return results.flat();
}

export async function checkBoundaries() {
  const sources = (await Promise.all(['apps', 'packages', 'migrations'].map((path) => files(resolve(root, path))))).flat();
  const failures = [];
  for (const path of sources) {
    const sourcePath = normalize(relative(root, path));
    const content = await readFile(path, 'utf8');
    const { specifiers, hasForbiddenForm } = inspectImports(sourcePath, content);
    // Projeto ESM: require/import calculado/import-equals não são permitidos.
    if (hasForbiddenForm) {
      failures.push(`${sourcePath}: use importações ESM estáticas para validar as fronteiras.`);
    }
    for (const specifier of specifiers) {
      if (!allowedImport(sourcePath, specifier)) failures.push(`${sourcePath}: importação proibida: ${specifier}`);
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'));
        if (!specifier.endsWith('.js') || !(await stat(target).catch(() => undefined))?.isFile()) {
          failures.push(`${sourcePath}: importação local precisa apontar para um módulo .js existente: ${specifier}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return sources.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Fronteiras verificadas: ${await checkBoundaries()} módulos.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
