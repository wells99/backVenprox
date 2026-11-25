import { createPool, type ConnectionOptions, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../../application/src/application-error.js';
import { mysqlBackup, mysqlRestore } from './backup.js';
import { mysqlMigrations } from '../../../../migrations/mysql/registry.js';
import { PersistenceError, type DatabaseIdentity, type PersistenceRepositories } from '../../../application/src/persistence.js';
import type { UnitOfWork } from '../../../application/src/ports.js';
import { assertIdentity, assertUuid, checksum, maxSequence, translatePersistenceError, validateOperation, type Migration } from '../../persistence/src/shared.js';

type History = RowDataPacket & { version: number; checksum: string; state: string; step: number };
export class MysqlStore {
  // Per-process diagnostics only; never an accounting/idempotency source.
  readonly metrics={commits:0,transaction_failures:0,deadlock_retries:0};
  private constructor(private readonly pool: Pool, readonly identity: DatabaseIdentity, readonly version: string) {}
  static async connect(options: ConnectionOptions, identity: DatabaseIdentity, connectionLimit=4) {
    if(!Number.isSafeInteger(connectionLimit)||connectionLimit<1||connectionLimit>4)throw new PersistenceError('INVALID_PERSISTED_VALUE');
    assertUuid(identity.store_id);
    if (identity.device_id) throw new PersistenceError('IDENTITY_MISMATCH');
    const pool = createPool({ ...options, connectionLimit, waitForConnections: true, queueLimit: 20, connectTimeout: 5000,
      supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, charset: 'utf8mb4_bin', dateStrings: true, jsonStrings: true });
    try {
      const [rows] = await pool.query<RowDataPacket[]>('SELECT VERSION() AS version');
      const version = String(rows[0]?.version);
      if (!version.startsWith('8.4.') && !/^11\.8\.\d+-MariaDB/.test(version)) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
      return new MysqlStore(pool, identity, version);
    } catch (error) { await pool.end(); throw translatePersistenceError(error); }
  }
  private async lock(connection: PoolConnection) {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(CONCAT('venprox-schema-',DATABASE()),3) AS acquired");
    if (Number(rows[0]?.acquired) !== 1) throw new PersistenceError('DATABASE_BUSY', true);
  }
  private async unlock(connection: PoolConnection) { await connection.query("SELECT RELEASE_LOCK(CONCAT('venprox-schema-',DATABASE()))"); }

  async migrate(migrations: readonly Migration[] = mysqlMigrations, afterStep?: (version: number, step: number) => void) {
    const connection = await this.pool.getConnection();
    let locked = false;
    try {
      await this.lock(connection); locked = true;
      await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY, checksum CHAR(64) NOT NULL, state VARCHAR(20) NOT NULL, step INT NOT NULL, applied_at VARCHAR(30)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
      const [history] = await connection.query<History[]>('SELECT * FROM schema_migrations ORDER BY version');
      for (const row of history) {
        const migration = migrations.find((item) => item.version === row.version);
        if (!migration) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
        if (checksum(migration) !== row.checksum) throw new PersistenceError('CHECKSUM_MISMATCH');
      }
      if (history.length && history.some((row) => row.state !== 'applied') || history.length > 0 && history.length < migrations.length) {
        await mkdir('artifacts/mysql-backups', { recursive: true });
        await mysqlBackup(connection, this.identity, resolve('artifacts/mysql-backups', `before-migration-${randomUUID()}.json`));
      }
      for (const migration of migrations) {
        const row = history.find((item) => item.version === migration.version);
        if (row?.state === 'applied') continue;
        if (!row) await connection.execute("INSERT INTO schema_migrations VALUES(?,?,'applying',0,NULL)", [migration.version, checksum(migration)]);
        try {
          for (let index = row?.step ?? 0; index < migration.steps.length; index++) {
            const step = migration.steps[index]!;
            // Dados e checkpoint de passos UPDATE precisam do mesmo commit.
            // DDL continua com checkpoints retomáveis e commit implícito do motor.
            const transactional=step.sql.startsWith('UPDATE ');
            if(transactional)await connection.beginTransaction();
            try {
            // DDL tem commit implícito. Após queda, verificar o objeto antes de repetir.
            if (step.sql.startsWith('CREATE INDEX')) {
              const [indexes] = await connection.query<RowDataPacket[]>("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='outbox_pending'", [step.table]);
              if (!indexes.length) await connection.query(step.sql);
            } else if (step.checkColumn) {
              const [existing]=await connection.query<RowDataPacket[]>('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[step.table,step.checkColumn]);
              if(!existing.length)await connection.query(step.sql);
            } else await connection.query(step.sql);
            const [columns] = await connection.query<RowDataPacket[]>('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [step.table]);
            if (JSON.stringify(columns.map((column) => column.COLUMN_NAME)) !== JSON.stringify(step.columns)) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
            const [tables] = await connection.query<RowDataPacket[]>('SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [step.table]);
            if (tables[0]?.ENGINE !== 'InnoDB' || tables[0]?.TABLE_COLLATION !== 'utf8mb4_bin') throw new PersistenceError('SCHEMA_INCOMPATIBLE');
            afterStep?.(migration.version, index);
            await connection.execute("UPDATE schema_migrations SET state='applying',step=? WHERE version=?", [index + 1, migration.version]);
            if(transactional)await connection.commit();
            }catch(error){if(transactional)await connection.rollback();throw error;}
          }
          await connection.execute("UPDATE schema_migrations SET state='applied',applied_at=? WHERE version=?", [new Date().toISOString(), migration.version]);
        } catch (error) {
          await connection.execute("UPDATE schema_migrations SET state='failed' WHERE version=?", [migration.version]);
          if (error instanceof PersistenceError) throw error;
          throw new PersistenceError('MIGRATION_FAILED');
        }
      }
    } catch (error) { throw translatePersistenceError(error); }
    finally { if (locked) await this.unlock(connection); connection.release(); }
  }

  async provisionIdentity() {
    try { await this.pool.execute('INSERT INTO instance_identity VALUES(1,?)', [this.identity.store_id]); }
    catch (error) { throw translatePersistenceError(error); }
  }
  async assertReady(connection: Pick<PoolConnection, 'query'> = this.pool, lockSchema = false) {
    const [identity] = await connection.query<RowDataPacket[]>('SELECT store_id FROM instance_identity WHERE singleton=1');
    assertIdentity(identity[0] ? { store_id: String(identity[0].store_id) } : undefined, this.identity);
    const [rows] = await connection.query<History[]>(`SELECT * FROM schema_migrations ORDER BY version${lockSchema ? this.version.includes('MariaDB') ? ' LOCK IN SHARE MODE' : ' FOR SHARE' : ''}`);
    if (rows.length !== mysqlMigrations.length || rows.some((row, index) => row.state !== 'applied' || row.version !== mysqlMigrations[index]!.version || row.checksum !== checksum(mysqlMigrations[index]!))) throw new PersistenceError('SCHEMA_INCOMPATIBLE');
  }

  unitOfWork<T = PersistenceRepositories>(extend?: (connection: PoolConnection, core: PersistenceRepositories, active: () => void) => T): UnitOfWork<T> {
    return { run: async (work) => {
      for (let attempt = 0; ; attempt++) {
        const connection = await this.pool.getConnection().catch((error: unknown) => { throw translatePersistenceError(error); });
        let active = true;
        const guard = () => { if (!active) throw new PersistenceError('TRANSACTION_CLOSED'); };
        const core: PersistenceRepositories = {
          sequences: { next: async (deviceId) => {
            guard(); assertUuid(deviceId);
            await connection.execute('INSERT INTO device_sequences VALUES(?,?,0) ON DUPLICATE KEY UPDATE sequence_value=sequence_value', [this.identity.store_id, deviceId]);
            const [rows] = await connection.query<RowDataPacket[]>('SELECT sequence_value FROM device_sequences WHERE store_id=? AND device_id=? FOR UPDATE', [this.identity.store_id, deviceId]);
            const previous = BigInt(String(rows[0]!.sequence_value));
            if (previous >= maxSequence) throw new PersistenceError('INVALID_PERSISTED_VALUE');
            const next = previous + 1n;
            await connection.execute('UPDATE device_sequences SET sequence_value=? WHERE store_id=? AND device_id=?', [next.toString(), this.identity.store_id, deviceId]);
            return next.toString();
          } },
          outbox: { append: async (operation) => {
            guard(); validateOperation(operation, this.identity);
            await connection.execute('INSERT INTO operation_outbox(operation_id,store_id,device_id,device_seq,occurred_at,event_type,payload,authorization_context) VALUES(?,?,?,?,?,?,?,?)',
              [operation.operation_id, operation.store_id, operation.device_id, operation.device_seq, operation.occurred_at, operation.event_type, operation.payload,operation.authorization?JSON.stringify(operation.authorization):null]);
          } },
          audit: { append: async (event) => {
            guard(); assertUuid(event.operation_id); assertUuid(event.device_id);
            if (event.store_id !== this.identity.store_id) throw new PersistenceError('IDENTITY_MISMATCH');
            await connection.execute('INSERT INTO audit_log(operation_id,store_id,device_id,occurred_at,action,actor_user_id,permissions_version,authorization_origin,authorization_id) VALUES(?,?,?,?,?,?,?,?,?)', [event.operation_id, event.store_id, event.device_id, event.occurred_at, event.action,event.actor_user_id??null,event.permissions_version??null,event.authorization_origin??'technical',event.authorization_id??null]);
          } },
        };
        try {
          await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await connection.beginTransaction();
          // O range lock compartilhado impede publicar nova migration no meio da transação.
          await this.assertReady(connection, true);
          const result = await work(extend ? extend(connection, core, guard) : core as T);
          await connection.commit();this.metrics.commits++;return result;
        } catch (error) {
          this.metrics.transaction_failures++;
          await connection.rollback().catch(() => {});
          if (error instanceof ApplicationError) throw error;
          const failure = translatePersistenceError(error);
          if (failure.code !== 'DEADLOCK' || attempt >= 2) throw failure;
          this.metrics.deadlock_retries++;
        } finally { active = false; connection.release(); }
      }
    } };
  }
  async status() {
    await this.assertReady();
    return { engine: this.version.includes('MariaDB') ? 'mariadb' : 'mysql', engine_version: this.version, schema_version: mysqlMigrations.at(-1)!.version, migration_state: 'applied', persistence_ready: true };
  }
  async backup(destination: string) {
    const connection = await this.pool.getConnection();
    let locked = false;
    try { await this.lock(connection); locked = true; await this.assertReady(connection); await mysqlBackup(connection, this.identity, destination); }
    catch (error) { throw translatePersistenceError(error); }
    finally { if (locked) await this.unlock(connection); connection.release(); }
  }
  async restore(source: string) {
    const connection = await this.pool.getConnection();
    let locked = false;
    try { await this.lock(connection); locked = true; await mysqlRestore(connection, this.identity, source); await this.assertReady(connection); }
    catch (error) { throw translatePersistenceError(error); }
    finally { if (locked) await this.unlock(connection); connection.release(); }
  }
  async close() { await this.pool.end(); }
}
