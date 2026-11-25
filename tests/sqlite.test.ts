import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openSqliteRuntime } from '../packages/infrastructure/sqlite/src/runtime-diagnostics.js';

test('SQLite real prova commit, rollback e persistência em arquivo técnico isolado', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-b01-'));
  const path = join(directory, 'probe.db');
  let database: Database.Database | undefined;
  try {
    database = new Database(path);
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('synchronous = FULL');
    database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = database.prepare('INSERT INTO probe (id, value) VALUES (?, ?)');
    database.transaction(() => insert.run(1, 'persisted'))();
    assert.throws(() => database?.transaction(() => {
      insert.run(2, 'rolled-back');
      throw new Error('injected-failure');
    })());
    database.close();
    database = new Database(path, { fileMustExist: true });
    assert.deepEqual(database.prepare('SELECT * FROM probe').all(), [{ id: 1, value: 'persisted' }]);
    database.close();
    database = undefined;
    const service = openSqliteRuntime(path);
    try {
      assert.equal(service.repository.inspect().storage_mode, 'existing_file');
      assert.throws(() => openSqliteRuntime(path));
      assert.equal((await readdir(directory)).some((entry) => entry.endsWith('.owner.lock')), true);
    } finally { service.close(); }
    assert.equal((await readdir(directory)).some((entry) => entry.endsWith('.owner.lock')), false);
    const reopened = openSqliteRuntime(path);
    reopened.close();
  } finally {
    database?.close();
    // Caminho absoluto criado por mkdtemp, nunca diretório de dados do usuário.
    await rm(directory, { recursive: true, force: true });
  }
});

test('arquivo ausente falha sem criar banco ou arquivo alternativo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'venprox-b01-missing-'));
  try {
    assert.throws(() => openSqliteRuntime(join(directory, 'missing.db')));
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
