import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import electron from 'electron';
import { backend, prepareSimulation } from './setup-simulation.js';

const children = new Set<ChildProcess>();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = once(child, 'exit');
    if (child.connected) child.disconnect();
    else child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(done => { timer = setTimeout(() => { child.kill(); done(); }, 12000); })]);
    clearTimeout(timer);
  }));
}
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('MYSQL_') && !key.startsWith('AUTH_') && !key.startsWith('LOCAL_') &&
  !['STORE_ID', 'DEVICE_ID', 'VENPROX_LOCAL_ENV', 'VENPROX_UI_DATA_DIRECTORY', 'ELECTRON_RUN_AS_NODE', 'RECOVERY_KEY_FILE'].includes(key)));
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('disconnect', () => { void stop(); });
try {
  const profile = await prepareSimulation();
  if (stopping) throw new Error('Inicialização interrompida.');
  const apiOnly = process.argv.includes('--api-only');
  if (!apiOnly) {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Inicie com npm run dev:docker.');
    for (const cwd of [join(backend, '../front-Venprox'), backend]) {
      const build = spawn(process.execPath, [npm, 'run', 'build'], { cwd, env: baseEnv, stdio: 'inherit', windowsHide: true });
      children.add(build);
      const [code] = await once(build, 'exit');
      children.delete(build);
      if (code !== 0 || stopping) throw new Error('Compilação interrompida.');
    }
  }
  const api = fork(join(backend, 'apps/api/src/main.ts'), [], { cwd: backend, execArgv: ['--import', 'tsx'],
    env: { ...baseEnv, ...profile.apiEnv }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  children.add(api);
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('A API local não ficou pronta. Confira a porta 3334.')), 20000);
    api.once('message', message => { clearTimeout(timer); if ((message as {type?:string}).type === 'ready') done(); else reject(new Error('Falha no início da API.')); });
    api.once('exit', () => { clearTimeout(timer); reject(new Error('A API local encerrou. Confira a porta 3334 e os logs.')); });
    api.once('error', error => { clearTimeout(timer); reject(error); });
  });
  if (!apiOnly && !stopping) {
    console.log('Abrindo terminal de simulação. Feche a janela para encerrar a API local.');
    console.log('Produtos: salvar → Revisar e confirmar → abrir caixa → vender.');
    const desktop = spawn(electron as unknown as string, ['dist/apps/native/src/main.js'], { cwd: backend,
      env: { ...baseEnv, ...profile.localEnv, VENPROX_NODE_PATH: process.execPath }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: process.env.VENPROX_QA_HIDDEN === 'true' });
    children.add(desktop);
    api.once('exit', () => { if (!stopping) { console.error('API local encerrada.'); void stop(); } });
    const [code] = await once(desktop, 'exit');
    if (!stopping) process.exitCode = Number(code ?? 1);
  } else if (!stopping) {
    console.log('API de simulação ativa. Ctrl+C encerra este processo.');
    await once(api, 'exit');
  }
} catch (error) {
  const message = error instanceof Error && (/^[A-Z_]+$/.test(error.message) || /^(Inicie com|Compilação interrompida|Inicialização interrompida|A API local|Falha no início)/.test(error.message))
    ? error.message : 'Não foi possível iniciar a simulação. Confira Docker, a porta 3334 e .env.b03.';
  console.error(message);
  process.exitCode = 1;
} finally { await stop(); }
