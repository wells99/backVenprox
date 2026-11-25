import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ApplicationError } from '../../../application/src/application-error.js';

const program = `Add-Type -AssemblyName System.Security
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($inputData.data)
$entropy = [Text.Encoding]::UTF8.GetBytes($inputData.context)
if ($inputData.mode -eq 'protect') {
  $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Console]::Out.Write([Convert]::ToBase64String($result))`;
async function transform(mode: 'protect' | 'unprotect', data: Buffer, context: string): Promise<Buffer> {
  if (process.platform !== 'win32') throw new ApplicationError('PROTECTED_STORAGE_UNAVAILABLE', 'Armazenamento protegido indisponível neste sistema.', 'unavailable');
  return new Promise((resolve, reject) => {
    const executable = join(process.env.SYSTEMROOT ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child = spawn(executable, ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(program,'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 10000);
    const fail = () => reject(new ApplicationError('PROTECTED_STORAGE_UNAVAILABLE', 'Não foi possível acessar o armazenamento protegido.', 'unavailable'));
    child.on('error', fail); child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1_000_000) child.kill(); });
    child.stderr.resume();
    child.on('close', (code) => { clearTimeout(timeout); if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output)) fail(); else resolve(Buffer.from(output,'base64')); });
    child.stdin.end(JSON.stringify({ mode, data: data.toString('base64'), context }));
  });
}
export function windowsSecretProtector(context: string) {
  return {
    protect: async (value: string) => (await transform('protect',Buffer.from(value),context)).toString('base64'),
    unprotect: async (value: string) => (await transform('unprotect',Buffer.from(value,'base64'),context)).toString(),
  };
}
