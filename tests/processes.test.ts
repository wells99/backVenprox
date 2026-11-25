import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Value } from 'typebox/value';
import { LocalDiagnosticsSchema, LocalErrorSchema } from '../packages/contracts/src/ipc.js';

function launch(app: string, extra: NodeJS.ProcessEnv = {}) {
  const child = fork(resolve(`apps/${app}/src/main.ts`), [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info',
      LOCAL_DATABASE_PATH: '', WORKER_MODE: '', API_HOST: '127.0.0.1', API_PORT: '3333',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function message(child: ChildProcess) {
  const [value] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
  return value as { type: string; service: string; address: string; error: { code: string }; data: Record<string, unknown> };
}

async function exit(child: ChildProcess) {
  const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
  return code;
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}

test('API inicia isoladamente, responde HTTP real e fecha no desligamento', { timeout: 20_000 }, async () => {
  const { child, output } = launch('api', { API_PORT: String(await unusedPort()) });
  try {
    const ready = await message(child);
    assert.equal(ready.service, 'api');
    const response = await fetch(`${ready.address}/health`);
    assert.deepEqual(await response.json(), { status: 'ok' });
    const stopped = exit(child);
    // Desconexão do supervisor é portável para Windows e Unix.
    child.disconnect();
    assert.equal(await stopped, 0);
    assert.match(output(), /shutdown_complete/);
    await assert.rejects(fetch(`${ready.address}/health`));
  } finally { if (child.exitCode === null) child.kill(); }
});

test('serviço local diagnostica SQLite sem URL remota e valida IPC', { timeout: 20_000 }, async () => {
  const { child, output } = launch('local-service', { LOCAL_DATABASE_PATH: ':memory:' });
  try {
    assert.equal((await message(child)).service, 'local-service');
    const invalid = message(child);
    child.send({ type: 'sql', sql: 'secret-canary' });
    const rejected = await invalid;
    assert.equal(rejected.error.code, 'INVALID_COMMAND');
    assert.equal(Value.Check(LocalErrorSchema, rejected), true);
    const diagnostic = message(child);
    child.send({ type: 'diagnostics', request_id: 'diag-1' });
    const response = await diagnostic;
    assert.equal(Value.Check(LocalDiagnosticsSchema, response), true);
    assert.equal(response.data.engine, 'sqlite');
    assert.equal(response.data.storage_mode, 'ephemeral');
    assert.equal(response.data.persistence_ready, false);
    const stopped = exit(child);
    child.send({ type: 'shutdown', request_id: 'stop-1' });
    assert.equal(await stopped, 0);
    assert.match(output(), /shutdown_complete/);
    assert.equal(output().includes('secret-canary'), false);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('worker separado inicia em espera e fecha sem abrir SQLite', { timeout: 20_000 }, async () => {
  const { child, output } = launch('worker', { WORKER_MODE: 'standby', LOCAL_DATABASE_PATH: 'invalid-secret-canary' });
  try {
    assert.equal((await message(child)).service, 'worker');
    const stopped = exit(child);
    child.disconnect();
    assert.equal(await stopped, 0);
    assert.match(output(), /"jobs_enabled":false/);
    assert.match(output(), /shutdown_complete/);
    assert.equal(output().includes('secret-canary'), false);
  } finally { if (child.exitCode === null) child.kill(); }
});

test('cada composição falha no boot com configuração inválida e mensagem segura', { timeout: 30_000 }, async () => {
  for (const [app, env] of [
    ['api', { API_PORT: 'secret-canary' }],
    ['local-service', { LOCAL_DATABASE_PATH: 'secret-canary' }],
    ['worker', { WORKER_MODE: 'secret-canary' }],
  ] as const) {
    const { child, output } = launch(app, env);
    try {
      assert.equal(await exit(child), 1);
      assert.match(output(), /INVALID_CONFIGURATION/);
      assert.equal(output().includes('secret-canary'), false);
    } finally { if (child.exitCode === null) child.kill(); }
  }
});
