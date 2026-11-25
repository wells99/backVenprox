import assert from 'node:assert/strict';
import { createConnection, type ConnectionOptions, type RowDataPacket } from 'mysql2/promise';

// Prova técnica isolada; não é migração nem adaptador de vendas.
export async function proveMysqlTransaction(options: ConnectionOptions) {
  const connection = await createConnection({
    ...options,
    connectTimeout: 5000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4',
  });
  try {
    const [versions] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const version = String(versions[0]?.version);
    // Homologar MariaDB/outros separadamente; a matriz inicial é MySQL 8.4 LTS.
    assert.match(version, /^8\.4\./, 'UNVERIFIED_MYSQL_ENGINE');
    await connection.query('CREATE TEMPORARY TABLE venprox_b01_probe (id INT PRIMARY KEY, value VARCHAR(64) NOT NULL) ENGINE=InnoDB');
    await connection.beginTransaction();
    await connection.execute('INSERT INTO venprox_b01_probe (id, value) VALUES (?, ?)', [1, 'commit']);
    await connection.commit();
    await connection.beginTransaction();
    await connection.execute('INSERT INTO venprox_b01_probe (id, value) VALUES (?, ?)', [2, 'rollback']);
    await connection.rollback();
    const [rows] = await connection.query<RowDataPacket[]>('SELECT id, value FROM venprox_b01_probe ORDER BY id');
    assert.deepEqual(rows.map((row) => ({ id: row.id, value: row.value })), [{ id: 1, value: 'commit' }]);
    return { engine: 'mysql', engine_version: version, commit: true, rollback: true };
  } finally {
    await connection.end();
  }
}
