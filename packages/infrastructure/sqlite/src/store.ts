import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../../application/src/application-error.js';
import Database from 'better-sqlite3';
import { sqliteMigrations } from '../../../../migrations/sqlite/registry.js';
import { PersistenceError, type DatabaseIdentity, type PersistenceRepositories } from '../../../application/src/persistence.js';
import type { RuntimeDiagnosticsRepository, UnitOfWork } from '../../../application/src/ports.js';
import { assertIdentity, assertUuid, checksum, maxSequence, translatePersistenceError, validateOperation, type Migration } from '../../persistence/src/shared.js';

interface History { version: number; checksum: string; state: string; step: number }
export class SqliteStore {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing = false;
  private constructor(readonly database: Database.Database, readonly path: string, readonly identity: DatabaseIdentity,
    private readonly lockFd: number, private readonly lockPath: string) {}

  static open(path: string, identity: DatabaseIdentity, provision = false, maintenance = false): SqliteStore {
    assertUuid(identity.store_id); assertUuid(identity.device_id ?? '');
    const absolute = resolve(path);
    if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//') || /(?:^|[\\/])OneDrive(?:[\\/]|$)/i.test(path) || absolute.startsWith(`${resolve('.')}\\`)) {
      throw new PersistenceError('DATABASE_PERMISSION');
    }
    if (!existsSync(absolute) && !provision) throw new PersistenceError('DATABASE_MISSING');
    if (existsSync(absolute) && provision) throw new PersistenceError('UNIQUE_CONFLICT');
    if (provision) mkdirSync(dirname(absolute), { recursive: true });
    const manifest = `${absolute}.identity.json`;
    if (provision) {
      if (existsSync(manifest)) assertIdentity(JSON.parse(readFileSync(manifest, 'utf8')) as DatabaseIdentity, identity);
      else writeFileSync(manifest, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    }
    const resolvedPath = existsSync(absolute) ? realpathSync(absolute) : resolve(realpathSync(dirname(absolute)), absolute.split(/[\\/]/).at(-1)!);
    const lockPath = `${resolvedPath}.owner.lock`;
    let fd: number | undefined;
    let db: Database.Database | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600); writeFileSync(fd, String(process.pid));
      db = new Database(resolvedPath, { fileMustExist: !provision, timeout: 1000 });
      db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL');
      const version = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
      const parts = version.split('.').map(Number);
      if (parts[0] !== 3 || parts[1]! < 51 || (parts[1] === 51 && parts[2]! < 3)) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
      const store = new SqliteStore(db, resolvedPath, identity, fd, lockPath);
      if (!provision) {
        const table = db.prepare("SELECT name FROM sqlite_master WHERE name='instance_identity'").get();
        const row = table ? db.prepare('SELECT store_id,device_id FROM instance_identity WHERE singleton=1').get() as DatabaseIdentity | undefined : undefined;
        if (!row && maintenance && existsSync(manifest)) assertIdentity(JSON.parse(readFileSync(manifest, 'utf8')) as DatabaseIdentity, identity);
        else store.validateIdentity();
      }
      return store;
    } catch (error) {
      db?.close();
      if (fd !== undefined) { closeSync(fd); unlinkSync(lockPath); }
      throw translatePersistenceError(error);
    }
  }

  validateIdentity() {
    try {
      const row = this.database.prepare('SELECT store_id,device_id FROM instance_identity WHERE singleton=1').get() as DatabaseIdentity | undefined;
      assertIdentity(row, this.identity);
    } catch (error) { throw translatePersistenceError(error); }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new PersistenceError('TRANSACTION_CLOSED'));
    const result = this.tail.then(() => { if (this.closed) throw new PersistenceError('TRANSACTION_CLOSED'); return work(); });
    this.tail = result.catch(() => {});
    return result;
  }

  async migrate(migrations: readonly Migration[] = sqliteMigrations, afterStep?: (version: number, step: number) => void): Promise<void> {
    return this.enqueue(async () => {
      const db = this.database;
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
      if (exists) {
        const current = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() as History[];
        if (current.some((row) => !migrations.some((migration) => migration.version === row.version))) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
        for (const row of current) if (checksum(migrations.find((m) => m.version === row.version)!) !== row.checksum) throw new PersistenceError('CHECKSUM_MISMATCH');
        if (current.some((row) => row.state !== 'applied') || current.length < migrations.length) await this.backupUnchecked(`${this.path}.before-migration-${randomUUID()}.db`);
      }
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, state TEXT NOT NULL, step INTEGER NOT NULL, applied_at TEXT)");
      for (const migration of migrations) {
        const row = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(migration.version) as History | undefined;
        if (row?.state === 'applied') continue;
        try {
          db.exec('BEGIN IMMEDIATE');
          db.prepare("INSERT OR REPLACE INTO schema_migrations VALUES (?,?,'applying',0,NULL)").run(migration.version, checksum(migration));
          migration.steps.forEach((step, index) => { db.exec(step.sql); afterStep?.(migration.version, index); });
          db.prepare("UPDATE schema_migrations SET state='applied',step=?,applied_at=? WHERE version=?").run(migration.steps.length, new Date().toISOString(), migration.version);
          db.exec('COMMIT');
        } catch {
          if (db.inTransaction) db.exec('ROLLBACK');
          db.prepare("INSERT OR REPLACE INTO schema_migrations VALUES (?,?,'failed',0,NULL)").run(migration.version, checksum(migration));
          throw new PersistenceError('MIGRATION_FAILED');
        }
      }
    });
  }

  async provisionIdentity() {
    return this.enqueue(async () => {
      this.database.prepare('INSERT INTO instance_identity(singleton,store_id,device_id) VALUES(1,?,?)').run(this.identity.store_id, this.identity.device_id!);
      this.validateIdentity();
    });
  }

  unitOfWork<T = PersistenceRepositories>(extend?: (database: Database.Database, core: PersistenceRepositories, active: () => void) => T): UnitOfWork<T> {
    return { run: (work) => this.enqueue(async () => {
      this.assertReady();
      const db = this.database;
      let active = true;
      const guard = () => { if (!active) throw new PersistenceError('TRANSACTION_CLOSED'); };
      const core: PersistenceRepositories = {
        sequences: { next: async (deviceId) => {
          guard(); assertUuid(deviceId);
          if (deviceId !== this.identity.device_id) throw new PersistenceError('IDENTITY_MISMATCH');
          db.prepare('INSERT INTO device_sequences VALUES(?,?,0) ON CONFLICT DO NOTHING').run(this.identity.store_id, deviceId);
          const row = db.prepare('SELECT sequence_value FROM device_sequences WHERE store_id=? AND device_id=?').safeIntegers().get(this.identity.store_id, deviceId) as { sequence_value: bigint };
          if (row.sequence_value >= maxSequence) throw new PersistenceError('INVALID_PERSISTED_VALUE');
          const next = row.sequence_value + 1n;
          db.prepare('UPDATE device_sequences SET sequence_value=? WHERE store_id=? AND device_id=?').run(next, this.identity.store_id, deviceId);
          return next.toString();
        } },
        outbox: { append: async (operation) => {
          guard(); validateOperation(operation, this.identity);
          db.prepare('INSERT INTO operation_outbox(operation_id,store_id,device_id,device_seq,occurred_at,event_type,payload,authorization_context) VALUES(?,?,?,?,?,?,?,?)')
            .run(operation.operation_id, operation.store_id, operation.device_id, BigInt(operation.device_seq), operation.occurred_at, operation.event_type, operation.payload,operation.authorization?JSON.stringify(operation.authorization):null);
        } },
        audit: { append: async (event) => {
          guard(); assertUuid(event.operation_id);
          if (event.store_id !== this.identity.store_id || event.device_id !== this.identity.device_id) throw new PersistenceError('IDENTITY_MISMATCH');
          db.prepare('INSERT INTO audit_log(operation_id,store_id,device_id,occurred_at,action,actor_user_id,permissions_version,authorization_origin,authorization_id) VALUES(?,?,?,?,?,?,?,?,?)').run(event.operation_id, event.store_id, event.device_id, event.occurred_at, event.action,event.actor_user_id??null,event.permissions_version??null,event.authorization_origin??'technical',event.authorization_id??null);
        } },
      };
      try {
        db.exec('BEGIN IMMEDIATE');
        const context = extend ? extend(db, core, guard) : core as T;
        const result = await work(context);
        db.exec('COMMIT'); return result;
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        if (error instanceof ApplicationError) throw error;
        throw translatePersistenceError(error);
      } finally { active = false; }
    }) };
  }

  assertReady() {
    this.validateIdentity();
    const rows = this.database.prepare('SELECT * FROM schema_migrations ORDER BY version').all() as History[];
    if (rows.length !== sqliteMigrations.length || rows.some((row, index) => row.state !== 'applied' || row.version !== sqliteMigrations[index]!.version || row.checksum !== checksum(sqliteMigrations[index]!))) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
  }
  async backup(destination: string) { return this.enqueue(() => this.backupUnchecked(destination)); }
  private async backupUnchecked(destination: string) {
    if (!isAbsolute(destination) || existsSync(destination) || resolve(destination) === this.path) throw new PersistenceError('UNIQUE_CONFLICT');
    if (!existsSync(dirname(destination))) throw new PersistenceError('DATABASE_MISSING');
    try {
      await this.database.backup(destination);
      const copy = new Database(destination, { readonly: true, fileMustExist: true });
      try {
        if (copy.pragma('integrity_check', { simple: true }) !== 'ok' || (copy.pragma('foreign_key_check') as unknown[]).length) throw new PersistenceError('DATABASE_CORRUPT');
      } finally { copy.close(); }
    } catch (error) { throw translatePersistenceError(error); }
  }
  status() {
    this.assertReady();
    return { engine: 'sqlite', engine_version: (this.database.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
      schema_version: sqliteMigrations.at(-1)!.version, migration_state: 'applied', persistence_ready: true };
  }
  async close() {
    this.closing = true;
    await this.tail;
    if (this.closed) return;
    this.database.close(); closeSync(this.lockFd); unlinkSync(this.lockPath); this.closed = true;
  }
}

export async function openLocalPersistence(path: string, identity: DatabaseIdentity) {
  const store = SqliteStore.open(path, identity);
  try {
    store.assertReady();
    const repository: RuntimeDiagnosticsRepository = { inspect: () => {
      const status = store.status();
      return { engine: 'sqlite', engine_version: status.engine_version, storage_mode: 'existing_file',
        persistence_ready: true, schema_version: status.schema_version, migration_state: 'applied' };
    } };
    return { repository, unitOfWork: store.unitOfWork(), store, close: () => store.close() };
  } catch (error) { await store.close(); throw error; }
}
