import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Esta prova exige Windows x64.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Destino novo em toda execução: nunca apagar uma pasta calculada de distribuição.
const destination = resolve(root, 'artifacts', `local-win-x64-${Date.now()}`);
await mkdir(destination, { recursive: true });
await copyFile(process.execPath, resolve(destination, 'node.exe'));
await cp(resolve(root, 'dist'), resolve(destination, 'dist'), { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
await writeFile(resolve(destination, 'package.json'), JSON.stringify({ type: 'module', private: true, dependencies: manifest.dependencies }, null, 2));
await copyFile(resolve(root, 'package-lock.json'), resolve(destination, 'package-lock.json'));
// Copiar as dependências de produção já instaladas e o binding nativo já validado.
// O destino não depende de npm, rede ou compilação C++ para iniciar.
const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const { stdout } = await promisify(execFile)(process.execPath, [npmCli, 'ls', '--omit=dev', '--all', '--parseable'], {
  cwd: root, windowsHide: true,
});
for (const source of new Set(stdout.trim().split(/\r?\n/).filter((path) => path && resolve(path) !== root))) {
  const packagePath = relative(root, source);
  if (!packagePath.startsWith(`node_modules\\`) && !packagePath.startsWith('node_modules/')) {
    throw new Error('Dependência fora da árvore instalada; revisar antes de empacotar.');
  }
  await cp(source, resolve(destination, packagePath), { recursive: true });
}
await writeFile(resolve(destination, 'start-local.cmd'), '@echo off\r\n"%~dp0node.exe" --env-file-if-exists="%~dp0.env.local" "%~dp0dist\\apps\\local-service\\src\\main.js"\r\n');
// Configuração efêmera da prova, sem depender dos exemplos privados do checkout.
await writeFile(resolve(destination, '.env.local'), 'NODE_ENV=development\nLOG_LEVEL=info\nLOCAL_DATABASE_PATH=:memory:\n');
const { smokeLocal } = await import('./smoke-local.ts');
// Provar fora do repositório impede resolver dependências acidentalmente no node_modules de desenvolvimento.
const isolated = await mkdtemp(join(tmpdir(), 'venprox-windows-package-'));
await cp(destination, isolated, { recursive: true });
const proof = await smokeLocal(resolve(isolated, 'node.exe'), resolve(isolated, 'dist/apps/local-service/src/main.js'), 30_000);
await writeFile(resolve(destination, 'proof.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ event: 'windows_package_verified', directory: destination, isolated_directory: isolated, ...proof }));
