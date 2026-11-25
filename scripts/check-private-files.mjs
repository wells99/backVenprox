import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Verifica o índice inteiro, inclusive arquivos já rastreados antes do .gitignore.
const workingTree = process.argv.includes('--working-tree');
const files = [...new Set(execFileSync('git', workingTree ? ['ls-files', '-co', '--exclude-standard', '-z'] : ['ls-files', '-z'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))];
const privateValues = readdirSync('.',{withFileTypes:true}).filter((entry)=>entry.isFile()&&entry.name.startsWith('.env')).flatMap((entry)=>
  Object.entries(parseEnv(readFileSync(entry.name,'utf8'))).filter(([name])=>/(?:PASSWORD|SECRET|TOKEN|FINGERPRINT_KEY)$/.test(name)).map(([,value])=>value)).filter((value)=>value.length>=12);
const privatePath = /(?:^|\/)(?:\.env[^/]*|backdocs|docs|node_modules|artifacts|dist)(?:\/|$)|\.(?:md|db|sqlite|pem|key)$/i;
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|https?:\/\/[^\s/@]+:[^\s/@]+@/;
const failures = [];
for (const path of files) {
  if (privatePath.test(path)) failures.push(`${path}: arquivo privado no índice`);
  // Ler o conteúdo do índice, que é exatamente o conteúdo do commit.
  const content = workingTree ? readFileSync(path, 'utf8') : execFileSync('git', ['show', `:${path}`], { encoding: 'utf8', windowsHide: true });
  if (secret.test(content)) failures.push(`${path}: possível credencial no índice`);
  if (privateValues.some((value) => content.includes(value))) failures.push(`${path}: credencial privada encontrada`);
}
// Confirmar também as exclusões dos arquivos locais privados.
const ignores = readFileSync('.gitignore', 'utf8');
if (!ignores.includes('.env*') || !ignores.includes('/backdocs/')) failures.push('.gitignore: exclusões obrigatórias ausentes');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Privacidade verificada: ${files.length} arquivos ${workingTree ? 'de trabalho' : 'no índice'}, sem documentação, arquivos de ambiente ou padrões conhecidos de credenciais.`);
}
