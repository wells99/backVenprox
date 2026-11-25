import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { PersistenceError, type DatabaseIdentity } from '../../../application/src/persistence.js';
import { mysqlMigrations } from '../../../../migrations/mysql/registry.js';

const tableShapes = (version: number): Record<string, readonly string[]> => Object.fromEntries(mysqlMigrations.filter((migration)=>migration.version<=version)
  .flatMap((migration) => migration.steps).map((step) => [step.table, step.columns]));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface Snapshot { format: 1; identity: DatabaseIdentity; tables: Record<string, unknown[][]>; schema_version: number }

export async function mysqlBackup(connection: PoolConnection, identity: DatabaseIdentity, destination: string) {
  const snapshot: Snapshot = { format: 1, identity, tables: {}, schema_version: 0 };
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  try {
    const [history] = await connection.query<RowDataPacket[]>("SELECT MAX(version) AS version FROM schema_migrations WHERE state='applied'");
    snapshot.schema_version = Number(history[0]?.version ?? 0);
    const tables=tableShapes(snapshot.schema_version);
    for (const [table, columns] of Object.entries(tables)) {
      const [exists] = await connection.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
      if (!exists.length) continue;
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${columns.join(',')} FROM ${table}`);
      snapshot.tables[table] = rows.map((row) => columns.map((column) => row[column]));
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  const data = JSON.stringify(snapshot);
  await writeFile(destination, JSON.stringify({ checksum: digest(data), data }), { flag: 'wx', mode: 0o600 });
}

// Restaura somente em schema recém-migrado e vazio. Nunca executa SQL vindo do backup.
export async function mysqlRestore(connection: PoolConnection, identity: DatabaseIdentity, source: string) {
  const file = await readFile(source, 'utf8');
  let snapshot: Snapshot;
  let tables: Record<string,readonly string[]>;
  try {
    const envelope = JSON.parse(file) as { checksum: string; data: string };
    if (digest(envelope.data) !== envelope.checksum) throw new Error();
    snapshot = JSON.parse(envelope.data) as Snapshot;
    tables=tableShapes(snapshot.schema_version);
    if (snapshot.format !== 1 || snapshot.identity.store_id !== identity.store_id || snapshot.identity.device_id ||
      snapshot.schema_version < 1 || snapshot.schema_version > mysqlMigrations.at(-1)!.version || Object.keys(snapshot.tables).some((table) => !tables[table])) throw new Error();
    for (const [table, columns] of Object.entries(tables)) {
      if (!Array.isArray(snapshot.tables[table]) || snapshot.tables[table]!.some((row) => !Array.isArray(row) || row.length !== columns.length)) throw new Error();
    }
  } catch { throw new PersistenceError('DATABASE_CORRUPT'); }
  await connection.beginTransaction();
  try {
    for (const [table, columns] of Object.entries(tables)) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM ${table}`);
      if (Number(rows[0]?.total)) throw new PersistenceError('UNIQUE_CONFLICT');
      for (const row of snapshot.tables[table]!) await connection.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, row);
    }
    const [rows] = await connection.query<RowDataPacket[]>('SELECT store_id FROM instance_identity WHERE singleton=1');
    if (rows[0]?.store_id !== identity.store_id) throw new PersistenceError('IDENTITY_MISMATCH');
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
}
