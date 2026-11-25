import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';

export async function smokeLocal(executable = process.execPath, entry = resolve('dist/apps/local-service/src/main.js'), timeoutMs = 10_000) {
  const child = fork(entry, [], {
    execPath: executable,
    execArgv: [],
    env: { ...process.env, NODE_ENV: 'test', LOCAL_DATABASE_PATH: ':memory:', LOG_LEVEL: 'silent' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const exited = once(child, 'exit', { signal: controller.signal });
  // A rejeição também é tratada se o boot falhar antes da espera pelo exit.
  void exited.catch(() => {});
  try {
    const unexpectedExit = exited.then(() => { throw new Error('LOCAL_PROCESS_EXITED_BEFORE_RESPONSE'); });
    const [ready] = await Promise.race([once(child, 'message', { signal: controller.signal }), unexpectedExit]);
    assert.equal(ready.type, 'ready');
    child.send({ type: 'diagnostics', request_id: 'smoke_b01' });
    const [diagnostics] = await Promise.race([once(child, 'message', { signal: controller.signal }), unexpectedExit]);
    assert.equal(diagnostics.type, 'diagnostics');
    assert.equal(diagnostics.meta.request_id, 'smoke_b01');
    assert.equal(diagnostics.data.engine, 'sqlite');
    assert.equal(diagnostics.data.storage_mode, 'ephemeral');
    assert.equal(diagnostics.data.persistence_ready, false);
    child.send({ type: 'shutdown', request_id: 'stop_b01' });
    const [code] = await exited;
    assert.equal(code, 0);
    return { node: process.versions.node, platform: process.platform, arch: process.arch, ...diagnostics.data };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
}

if (process.argv[1]?.endsWith('smoke-local.ts')) {
  console.log(JSON.stringify({ event: 'local_smoke_passed', ...await smokeLocal() }));
}
