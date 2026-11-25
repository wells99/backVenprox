import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { sqliteMigrations } from '../migrations/sqlite/registry.js';
import { mysqlMigrations } from '../migrations/mysql/registry.js';
import { PersistenceError, type PersistenceRepositories } from '../packages/application/src/persistence.js';
import { translatePersistenceError } from '../packages/infrastructure/persistence/src/shared.js';
import type { UnitOfWork } from '../packages/application/src/ports.js';

type Context = PersistenceRepositories & { aggregate: { save(id: string): Promise<void> } };
const failCode = (code: string) => (error: unknown) => error instanceof PersistenceError && error.code === code;
async function removeFixture(directory: string) {
  assert.equal(await realpath(dirname(directory)), await realpath(tmpdir()));
  assert.ok(basename(directory).startsWith('venprox-b03-'));
  await rm(directory, { recursive: true, force: true });
}
async function record(uow: UnitOfWork<Context>, store: string, device: string, operationId = randomUUID(), fail = false) {
  return uow.run(async (repositories) => {
    const sequence = await repositories.sequences.next(device);
    await repositories.aggregate.save(operationId);
    const event = { operation_id: operationId, store_id: store, device_id: device, occurred_at: '2026-11-24T12:00:00.000Z' };
    await repositories.outbox.append({ ...event, device_seq: sequence, event_type: 'technical.probe.v1', payload: '{"amount_cents":123}' });
    await repositories.audit.append({ ...event, action: 'probe.created' });
    if (fail) throw new Error('injected failure');
    return sequence;
  });
}

test('SQLite B03: migração, falha/retomada, transação de agregado/outbox/auditoria e backup restaurável', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-b03-sqlite-'));
  const path = join(directory, 'terminal.db');
  const identity = { store_id: randomUUID(), device_id: randomUUID() };
  let store: SqliteStore | undefined;
  try {
    assert.throws(() => SqliteStore.open(path, identity), failCode('DATABASE_MISSING'));
    store = SqliteStore.open(path, identity, true);
    await store.migrate(sqliteMigrations.slice(0, 1));
    await store.provisionIdentity();
    await assert.rejects(store.migrate(sqliteMigrations, (version) => { if (version === 2) throw new Error('injected migration failure'); }), failCode('MIGRATION_FAILED'));
    await store.close();
    store = SqliteStore.open(path, identity, false, true);
    assert.throws(() => store!.assertReady(), failCode('SCHEMA_INCOMPATIBLE'));
    await store.migrate(); await store.migrate();
    assert.equal(store.status().schema_version, 4);
    assert.equal(store.database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(store.database.pragma('synchronous', { simple: true }), 2);
    assert.equal(store.database.pragma('journal_mode', { simple: true }), 'wal');
    assert.throws(() => SqliteStore.open(path, identity), failCode('DATABASE_BUSY'));
    await assert.rejects(store.migrate([{ ...sqliteMigrations[0]!, steps: [] }, ...sqliteMigrations.slice(1)]), failCode('CHECKSUM_MISMATCH'));
    store.database.exec('CREATE TABLE probe_aggregate(id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES instance_identity(store_id))');
    const uow = store.unitOfWork<Context>((db, core, active) => ({ ...core,
      aggregate: { save: async (id) => { active(); db.prepare('INSERT INTO probe_aggregate VALUES(?,?)').run(id, identity.store_id); } },
    }));
    assert.equal(await record(uow, identity.store_id, identity.device_id), '1');
    await assert.rejects(record(uow, identity.store_id, identity.device_id, randomUUID(), true));
    for (const table of ['probe_aggregate','operation_outbox','audit_log']) assert.equal((store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
    assert.deepEqual(await Promise.all([record(uow, identity.store_id, identity.device_id), record(uow, identity.store_id, identity.device_id)]), ['2','3']);
    const duplicate = randomUUID();
    await record(uow, identity.store_id, identity.device_id, duplicate);
    await assert.rejects(record(uow, identity.store_id, identity.device_id, duplicate), failCode('UNIQUE_CONFLICT'));
    await assert.rejects(uow.run(async () => { store!.database.prepare('INSERT INTO probe_aggregate VALUES(?,?)').run(randomUUID(), randomUUID()); }), failCode('FOREIGN_KEY_CONFLICT'));
    let escaped: PersistenceRepositories | undefined;
    await uow.run(async (repositories) => { escaped = repositories; });
    await assert.rejects(escaped!.sequences.next(identity.device_id), failCode('TRANSACTION_CLOSED'));
    const pageCount = Number(store.database.pragma('page_count', { simple: true }));
    store.database.pragma(`max_page_count=${pageCount}`);
    try {
      await assert.rejects(uow.run(async (repositories) => {
        const seq = await repositories.sequences.next(identity.device_id);
        await repositories.outbox.append({ operation_id: randomUUID(), store_id: identity.store_id, device_id: identity.device_id,
          device_seq: seq, occurred_at: '2026-11-24T12:00:00.000Z', event_type: 'probe.full', payload: JSON.stringify({ value: 'x'.repeat(60000) }) });
      }), failCode('DATABASE_FULL'));
    } finally { store.database.pragma('max_page_count=2147483647'); }
    store.database.prepare('UPDATE device_sequences SET sequence_value=?').run(9007199254740992n);
    assert.equal(await uow.run((repositories) => repositories.sequences.next(identity.device_id)), '9007199254740993');
    store.database.prepare('UPDATE device_sequences SET sequence_value=?').run(9223372036854775807n);
    await assert.rejects(uow.run((repositories) => repositories.sequences.next(identity.device_id)), failCode('INVALID_PERSISTED_VALUE'));
    const backup = join(directory, 'backup.db');
    await store.backup(backup);
    const restored = join(directory, 'restored.db');
    await copyFile(backup, restored);
    const copy = SqliteStore.open(restored, identity);
    try { copy.assertReady(); assert.equal((copy.database.prepare('SELECT COUNT(*) AS n FROM operation_outbox').get() as {n:number}).n, 4); }
    finally { await copy.close(); }
    await assert.rejects(store.backup(join(directory, 'absent', 'backup.db')), failCode('DATABASE_MISSING'));
    await store.close(); store = undefined;
    assert.throws(() => SqliteStore.open(path, { ...identity, store_id: randomUUID() }), failCode('IDENTITY_MISMATCH'));
    const corrupt = join(directory, 'corrupt.db');
    await writeFile(corrupt, 'not a SQLite database');
    assert.throws(() => SqliteStore.open(corrupt, identity), failCode('DATABASE_CORRUPT'));
    assert.equal((await readdir(directory)).some((name) => name.includes('before-migration')), true);
  } finally { await store?.close(); await removeFixture(directory); }
});

test('SQLite B03: instalação interrompida antes de identidade pode retomar sem criar outro banco', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-b03-install-'));
  const path = join(directory, 'terminal.db');
  const identity = { store_id: randomUUID(), device_id: randomUUID() };
  let store = SqliteStore.open(path, identity, true);
  try {
    await assert.rejects(store.migrate(sqliteMigrations, () => { throw new Error('stop'); }));
    await store.close();
    assert.throws(() => SqliteStore.open(path, identity), PersistenceError);
    store = SqliteStore.open(path, identity, false, true);
    await store.migrate(); await store.provisionIdentity();
    assert.equal(store.status().persistence_ready, true);
  } finally { await store.close(); await removeFixture(directory); }
});

test('tradução de erros nunca revela SQL, credenciais ou mensagem do driver', () => {
  for (const [code, expected] of [['ENOSPC','DATABASE_FULL'], ['EACCES','DATABASE_PERMISSION'], ['ER_LOCK_DEADLOCK','DEADLOCK'], ['SQLITE_BUSY','DATABASE_BUSY'], ['ECONNREFUSED','DATABASE_UNAVAILABLE']]) {
    const error = translatePersistenceError({ code, message: 'secret SELECT password' });
    assert.equal(error.code, expected);
    assert.equal(error.message.includes('secret'), false);
  }
});

test('serviço local abre a base B03 provisionada offline, valida identidade/schema e libera o dono ao sair', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-b03-process-'));
  const path = join(directory, 'terminal.db');
  const identity = { store_id: randomUUID(), device_id: randomUUID() };
  const store = SqliteStore.open(path, identity, true);
  await store.migrate(); await store.provisionIdentity(); await store.close();
  const child = fork(resolve('apps/local-service/src/main.ts'), [], { execArgv: ['--import','tsx'],
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', LOCAL_DATABASE_PATH: path, STORE_ID: identity.store_id, DEVICE_ID: identity.device_id,
      SYSTEMROOT: process.env.SYSTEMROOT, PATH: process.env.PATH }, stdio: ['ignore','ignore','ignore','ipc'] });
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
    assert.equal(ready.type, 'ready');
    const received = once(child, 'message', { signal: AbortSignal.timeout(10000) });
    child.send({ type: 'diagnostics', request_id: 'b03-diagnostic' });
    const [diagnostic] = await received;
    assert.equal(diagnostic.data.persistence_ready, true);
    assert.equal(diagnostic.data.schema_version, 4);
    assert.equal(diagnostic.meta.request_id, 'b03-diagnostic');
    const stopped = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
    child.send({ type: 'shutdown', request_id: 'b03-stop' });
    assert.equal((await stopped)[0], 0);
    const reopened = SqliteStore.open(path, identity); await reopened.close();
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    await removeFixture(directory);
  }
});

test('MySQL real B03: migrations retomáveis, rollback, concorrência, privilégios e backup/restauração', {
  skip: !process.env.MYSQL_PASSWORD, timeout: 90_000,
}, async () => {
  assert.equal(process.env.MYSQL_HOST, '127.0.0.1'); assert.equal(process.env.MYSQL_PORT, '3308');
  const options = { host: '127.0.0.1', port: 3308, user: 'venprox_migration', password: process.env.MYSQL_PASSWORD!, database: 'venprox_b03_test', supportBigNumbers: true, bigNumberStrings: true };
  const connection = await createConnection(options);
  const directory = await mkdtemp(join(tmpdir(), 'venprox-b03-mysql-'));
  const identity = { store_id: randomUUID() };
  const device = randomUUID();
  const clear = async () => {
    for (const table of ['auth_replays','auth_grants','auth_limits','auth_invites','auth_sessions','auth_devices','auth_users','auth_roles','auth_installation','probe_aggregate','audit_log','operation_outbox','device_sequences','instance_identity','schema_migrations']) await connection.query(`DROP TABLE IF EXISTS ${table}`);
  };
  let store: MysqlStore | undefined;
  try {
    await clear();
    store = await MysqlStore.connect(options, identity);
    await assert.rejects(store.migrate(mysqlMigrations, (version, step) => { if (version === 1 && step === 1) throw new Error('injected crash'); }), failCode('MIGRATION_FAILED'));
    await store.close(); store = await MysqlStore.connect(options, identity);
    await store.migrate(mysqlMigrations.slice(0, 1)); await store.provisionIdentity();
    await store.migrate(); await store.migrate();
    assert.equal((await store.status()).schema_version, 4);
    await connection.query("SELECT GET_LOCK(CONCAT('venprox-schema-',DATABASE()),1)");
    try { await assert.rejects(store.migrate(), failCode('DATABASE_BUSY')); }
    finally { await connection.query("SELECT RELEASE_LOCK(CONCAT('venprox-schema-',DATABASE()))"); }
    await assert.rejects(store.migrate([{ ...mysqlMigrations[0]!, steps: [] }, ...mysqlMigrations.slice(1)]), failCode('CHECKSUM_MISMATCH'));
    await connection.query('CREATE TABLE probe_aggregate(id VARCHAR(36) PRIMARY KEY,store_id VARCHAR(36) NOT NULL,FOREIGN KEY(store_id) REFERENCES instance_identity(store_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    const uow = store.unitOfWork<Context>((db, core, active) => ({ ...core, aggregate: { save: async (id) => {
      active(); await db.execute('INSERT INTO probe_aggregate VALUES(?,?)', [id, identity.store_id]);
    } } }));
    assert.equal(await record(uow, identity.store_id, device), '1');
    await assert.rejects(record(uow, identity.store_id, device, randomUUID(), true));
    for (const table of ['probe_aggregate','operation_outbox','audit_log']) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`); assert.equal(Number(rows[0]!.n), 1);
    }
    assert.deepEqual((await Promise.all([record(uow, identity.store_id, device), record(uow, identity.store_id, device)])).sort(), ['2','3']);
    const duplicate = randomUUID(); await record(uow, identity.store_id, device, duplicate);
    await assert.rejects(record(uow, identity.store_id, device, duplicate), failCode('UNIQUE_CONFLICT'));
    await assert.rejects(uow.run(async (repositories) => {
      await repositories.outbox.append({ operation_id: randomUUID(), store_id: identity.store_id, device_id: randomUUID(), device_seq: '1', occurred_at: '2026-11-24T12:00:00.000Z', event_type: 'probe', payload: '{}' });
    }), failCode('FOREIGN_KEY_CONFLICT'));
    let attempts = 0;
    assert.equal(await uow.run(async () => { if (++attempts < 3) throw { code: 'ER_LOCK_DEADLOCK' }; return 'retried'; }), 'retried');
    assert.equal(attempts, 3);
    const otherDevice = randomUUID();
    await uow.run((repositories) => repositories.sequences.next(otherDevice));
    let arrivals = 0;
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolveBarrier) => { releaseBarrier = resolveBarrier; });
    const runs = [0, 0];
    const locks = store.unitOfWork((db, core) => ({ ...core, lock: async (id: string) => {
      await db.execute('SELECT sequence_value FROM device_sequences WHERE store_id=? AND device_id=? FOR UPDATE', [identity.store_id, id]);
    } }));
    await Promise.all([[device, otherDevice], [otherDevice, device]].map(([first, second], index) => locks.run(async (repositories) => {
      runs[index] = runs[index]! + 1;
      await repositories.lock(first!);
      if (runs[index] === 1) { if (++arrivals === 2) releaseBarrier(); await barrier; }
      await repositories.lock(second!);
    })));
    assert.ok(runs.some((count) => count > 1), 'Deadlock real deve repetir a transação inteira.');
    await connection.execute('DELETE FROM device_sequences WHERE device_id=?', [otherDevice]);
    await connection.execute('UPDATE device_sequences SET sequence_value=?', ['9007199254740992']);
    assert.equal(await uow.run((repositories) => repositories.sequences.next(device)), '9007199254740993');
    await connection.execute('UPDATE device_sequences SET sequence_value=?', ['9223372036854775807']);
    await assert.rejects(uow.run((repositories) => repositories.sequences.next(device)), failCode('INVALID_PERSISTED_VALUE'));
    const backup = join(directory, 'backup.json');
    await store.backup(backup);
    await connection.query('DROP TABLE probe_aggregate');
    await store.close(); store = undefined;
    await clear();
    store = await MysqlStore.connect(options, identity); await store.migrate(); await store.restore(backup);
    assert.equal((await store.status()).persistence_ready, true);
    const [restored] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM operation_outbox'); assert.equal(Number(restored[0]!.n), 4);
    await assert.rejects(store.restore(backup), failCode('UNIQUE_CONFLICT'));
    const wrong = await MysqlStore.connect(options, { store_id: randomUUID() });
    try { await assert.rejects(wrong.status(), failCode('IDENTITY_MISMATCH')); } finally { await wrong.close(); }
    const tampered = join(directory, 'tampered.json'); await writeFile(tampered, (await readFile(backup, 'utf8')).replace('technical.probe.v1', 'changed'));
    await assert.rejects(store.restore(tampered), failCode('DATABASE_CORRUPT'));
    const api = await createConnection({ ...options, database: 'venprox_b03', user: 'venprox_api', password: process.env.MYSQL_API_PASSWORD! });
    try { await assert.rejects(api.query('CREATE TABLE forbidden_ddl(id INT)'), (error: unknown) => translatePersistenceError(error).code === 'DATABASE_PERMISSION'); }
    finally { await api.end(); }
    await assert.rejects(MysqlStore.connect({ ...options, port: 1, connectTimeout: 300 }, identity), failCode('DATABASE_UNAVAILABLE'));
  } finally { await store?.close(); await clear(); await connection.end(); await removeFixture(directory); }
});
