import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { SyncCoordinator } from '../packages/application/src/sync-coordinator.js';
import type { CoordinatorTransaction, SyncCoordinatorDependencies } from '../packages/application/src/sync-coordinator-ports.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { sqliteLocalSyncUnitOfWork } from '../packages/infrastructure/sqlite/src/local-sync.js';

test('pedido explícito durante telemetria agenda novo contato, sem perder ou duplicar ciclos', { timeout: 5000 }, async () => {
  const storeId = randomUUID(), deviceId = randomUUID();
  let contacts = 0, reports = 0, release!: () => void, entered!: () => void;
  const reporting = new Promise<void>(done => { entered = done; });
  const finishReport = new Promise<void>(done => { release = done; });
  const transaction = {
    replica: {
      runtime: async () => ({ initialized: true, cursor: '0', local_seq: '0', state: 'idle', enabled: false }),
      state: async () => {}, staged: async () => undefined, apply: async () => {},
    },
    sync: {
      contact: async () => { contacts++; }, sourceNext: async () => undefined,
      status: async () => ({ download_cursor: '0', pending: 0, in_flight: 0, acknowledged: 0, conflicts: 0,
        oldest_pending_at: null, last_receipt_at: null, phase: 'idle', last_code: null, automatic_sync_enabled: false }),
    },
  };
  const coordinator = new SyncCoordinator({
    storeId, deviceId,
    clock: { now: () => new Date() },
    unitOfWork: { run: async <T>(work: (tx: CoordinatorTransaction) => Promise<T>) => work(transaction as unknown as CoordinatorTransaction) },
    device: async () => ({ store_id: storeId, device_id: deviceId }),
    gateway: {
      compatible: async () => ({ store_id: storeId, device_id: deviceId, received_seq: '0', sync_enabled: true }),
      changes: async () => ({ items: [], has_more: false }),
      report: async () => { if (++reports === 1) { entered(); await finishReport; } },
    },
  } as unknown as SyncCoordinatorDependencies);
  const first = coordinator.cycle();
  await reporting;
  const second = coordinator.requestCycle(), concurrent = coordinator.requestCycle();
  assert.equal(contacts, 1);
  release();
  await Promise.all([first, second, concurrent]);
  assert.equal(contacts, 2);
  assert.equal(reports, 2);
});

test('nova tentativa substitui erro antigo por agendamento sem liberar recuperação', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-sync-request-'));
  const store = SqliteStore.open(join(directory, 'terminal.db'), { store_id: randomUUID(), device_id: randomUUID() }, true);
  try {
    await store.migrate(); await store.provisionIdentity();
    const unitOfWork = sqliteLocalSyncUnitOfWork(store);
    await unitOfWork.run(tx => tx.sync.initialize());
    store.database.prepare("UPDATE sync_runtime SET state='retry_wait',last_code='SYNC_REMOTE_UNAVAILABLE'").run();
    await unitOfWork.run(tx => tx.sync.requestRetry(new Date().toISOString()));
    const scheduled = await unitOfWork.run(tx => tx.sync.status());
    assert.equal(scheduled.phase, 'scheduled'); assert.equal(scheduled.last_code, null);
    store.database.prepare("UPDATE sync_runtime SET state='recovery_required',last_code='SYNC_RECOVERY_REQUIRED'").run();
    await unitOfWork.run(tx => tx.sync.requestRetry(new Date().toISOString()));
    const recovery = await unitOfWork.run(tx => tx.sync.status());
    assert.equal(recovery.phase, 'recovery_required'); assert.equal(recovery.last_code, 'SYNC_RECOVERY_REQUIRED');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
