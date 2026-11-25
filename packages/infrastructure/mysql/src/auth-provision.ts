import { createConnection, type ConnectionOptions, type RowDataPacket } from 'mysql2/promise';
import { rolePermissions } from '../../../domain/src/authorization.js';
import { ApplicationError } from '../../../application/src/application-error.js';

export async function provisionAuth(options: ConnectionOptions, storeId: string, setupHash: string, setupExpires: string, offlineTtl = 0) {
  const connection = await createConnection(options);
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<RowDataPacket[]>('SELECT store_id FROM auth_installation WHERE store_id=? FOR UPDATE', [storeId]);
    if (rows.length) throw new ApplicationError('INSTALLATION_ALREADY_PROVISIONED', 'Instalação já provisionada.', 'conflict');
    await connection.execute('INSERT INTO auth_installation VALUES(?,?,?,NULL,?, ?,1)', [storeId, setupHash, setupExpires, '', offlineTtl]);
    for (const [role, values] of Object.entries(rolePermissions)) await connection.execute('INSERT INTO auth_roles VALUES(?,?,?,1)', [storeId, role, JSON.stringify(values)]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.end(); }
}
