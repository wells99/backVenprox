import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import electron from 'electron';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';

test('launcher: desconectar durante a abertura encerra Electron e libera o SQLite', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-launcher-'));
  const path = join(directory, 'terminal.db');
  const identity = { store_id: randomUUID(), device_id: randomUUID() };
  const store = SqliteStore.open(path, identity, true);
  try { await store.migrate(); await store.provisionIdentity(); } finally { await store.close(); }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('MYSQL_') && !key.startsWith('AUTH_') && !key.startsWith('LOCAL_') &&
    !['ELECTRON_RUN_AS_NODE', 'RECOVERY_KEY_FILE'].includes(key)));
  const child = spawn(electron as unknown as string, [resolve('dist/apps/native/src/main.js')], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...env, NODE_ENV: 'test', LOG_LEVEL: 'silent', STORE_ID: identity.store_id, DEVICE_ID: identity.device_id,
      LOCAL_DATABASE_PATH: path, VENPROX_NODE_PATH: process.execPath, VENPROX_UI_DATA_DIRECTORY: join(directory, 'interface'), VENPROX_QA_HIDDEN: 'true' },
  });
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill(), 20000);
  try {
    const until = Date.now() + 15000;
    while (!existsSync(`${path}.owner.lock`) && Date.now() < until && child.exitCode === null)
      await new Promise(done => setTimeout(done, 20));
    assert.equal(existsSync(`${path}.owner.lock`), true, 'serviço local iniciou a abertura');
    child.disconnect();
    const [code] = await exited;
    assert.equal(code, 0);
    assert.equal(existsSync(`${path}.owner.lock`), false, 'bloqueio de escrita liberado');
    const reopened = SqliteStore.open(path, identity);
    try { reopened.validateIdentity(); } finally { await reopened.close(); }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && !child.signalCode) { child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
