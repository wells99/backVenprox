import { createConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';

try {
  const connection = await createConnection({ host: process.env.MYSQL_HOST!, port: Number(process.env.MYSQL_PORT ?? 3306),
    database: process.env.MYSQL_DATABASE!, user: process.env.MYSQL_USER!, password: process.env.MYSQL_PASSWORD!,
    connectTimeout: 8000, multipleStatements: false, ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } });
  try {
    const [version] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const [tables] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    const [ssl] = await connection.query<RowDataPacket[]>("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    console.log(JSON.stringify({ connected: true, engine_version: String(version[0]?.version), tables: Number(tables[0]?.total), tls: Boolean(ssl[0]?.Value), read_only_probe: true }));
  } finally { await connection.end(); }
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'CONNECTION_FAILED';
  console.log(JSON.stringify({ connected: false, code, credentials_redacted: true }));
  process.exitCode = 1;
}
