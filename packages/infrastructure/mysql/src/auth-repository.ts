import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { AuthDependencies, AuthDevice, AuthGrant, AuthInvite, AuthLimit, AuthReplay, AuthRepository, AuthSession, AuthTransaction, AuthUser, Installation } from '../../../application/src/auth-ports.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { Permission, Role } from '../../../domain/src/authorization.js';
import { rolePermissions } from '../../../domain/src/authorization.js';
import type { MysqlStore } from './store.js';
import { createHash } from 'node:crypto';
import { publicationRepository } from '../../persistence/src/publication-repository.js';
import type { PublicationRepository } from '../../../application/src/publication-ports.js';

export function mysqlAuthRepository(connection: Pick<Connection,'query'|'execute'>, storeId: string, active: () => void, publication?:PublicationRepository): AuthRepository {
  async function rows<T>(table: string, where = '', values: unknown[] = []): Promise<T[]> {
    active();
    const [result] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE store_id=? ${where} FOR UPDATE`, [storeId, ...values]);
    return result.map((row) => ({ ...row, ...('active' in row ? { active: Number(row.active) === 1 } : {}) })) as T[];
  }
  async function one<T>(table: string, where: string, values: unknown[]) { return (await rows<T>(table, where, values))[0]; }
  async function save(table: string, value: object, keys: readonly string[]) {
    active();
    if (!('store_id' in value) || value.store_id !== storeId) throw new ApplicationError('SCOPE_MISMATCH', 'Escopo inválido.', 'forbidden');
    const columns = Object.keys(value);
    const updates = columns.filter((column) => !keys.includes(column));
    const record = value as Record<string, unknown>;
    const predicate = keys.map((column) => `${column}=?`).join(' AND ');
    const [existing] = await connection.query<RowDataPacket[]>(`SELECT 1 FROM ${table} WHERE ${predicate}`, keys.map((column) => record[column]));
    if (existing.length) await connection.query(`UPDATE ${table} SET ${updates.map((column) => `${column}=?`).join(',')} WHERE ${predicate}`, [...updates.map((column) => record[column]), ...keys.map((column) => record[column])]);
    else await connection.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, Object.values(value));
  }
  async function publishReference(type:string,value:AuthUser|AuthDevice){
    if(!publication)return;
    const {id,store_id,active:enabled,version}=value;
    const safe='password_hash' in value?{id,store_id,active:enabled,version,name:value.name,role:value.role,permissions_version:value.permissions_version}:{id,store_id,active:enabled,version,code:value.code};
    const hex=createHash('sha256').update(`${type}:${storeId}:${id}:${version}`).digest('hex');
    const operation_id=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    await publication.publish({operation_id,type,source:'identity',payload:safe,published_at:new Date().toISOString()});
  }
  return {
    installation: async () => {
      active();
      const [result] = await connection.query<RowDataPacket[]>('SELECT * FROM auth_installation WHERE store_id=? FOR UPDATE', [storeId]);
      if (!result[0]) throw new ApplicationError('INSTALLATION_NOT_PROVISIONED', 'Instalação não provisionada.', 'unavailable');
      return result[0] as Installation;
    },
    saveInstallation: (value) => save('auth_installation', value, ['store_id']),
    user: (id) => one<AuthUser>('auth_users','AND id=?',[id]), userByLogin: (login) => one<AuthUser>('auth_users','AND login_key=?',[login]),
    users: () => rows<AuthUser>('auth_users','ORDER BY login_key LIMIT 100'), saveUser: async(value) => {await save('auth_users', value, ['id','store_id']);await publishReference('authorization.user.updated.v1',value);},
    sessionByAccess: (hash) => one<AuthSession>('auth_sessions','AND access_hash=?',[hash]), sessionByRefresh: (hash) => one<AuthSession>('auth_sessions','AND refresh_hash=?',[hash]),
    saveSession: (value) => save('auth_sessions', value, ['id','store_id']),
    revokeUserSessions: async (id, at) => { active(); await connection.execute('UPDATE auth_sessions SET revoked_at=? WHERE store_id=? AND user_id=?', [at, storeId, id]); },
    device: (id) => one<AuthDevice>('auth_devices','AND id=?',[id]), deviceByCredential: (hash) => one<AuthDevice>('auth_devices','AND credential_hash=?',[hash]),
    devices: () => rows<AuthDevice>('auth_devices','ORDER BY code LIMIT 100'), saveDevice: async(value) => {await save('auth_devices', value, ['id','store_id']);await publishReference('authorization.device.updated.v1',value);},
    inviteByHash: (hash) => one<AuthInvite>('auth_invites','AND token_hash=?',[hash]), saveInvite: (value) => save('auth_invites', value, ['id','store_id']),
    limit: (bucket) => one<AuthLimit>('auth_limits','AND bucket=?',[bucket]), saveLimit: (value) => save('auth_limits', value, ['bucket','store_id']),
    rolePermissions: async (role: Role) => {
      const row = await one<{ permissions: unknown }>('auth_roles','AND role=?',[role]);
      if (!row) return [];
      const allowed: unknown = typeof row.permissions === 'string' ? JSON.parse(row.permissions)
        : Buffer.isBuffer(row.permissions) ? JSON.parse(row.permissions.toString()) : row.permissions;
      return Array.isArray(allowed) ? allowed.filter((permission): permission is Permission => rolePermissions[role].includes(permission as Permission)) : [];
    },
    saveGrant: (value: AuthGrant) => save('auth_grants', value, ['id','store_id']),
    revokeGrants: async (userId, deviceId, at) => { active(); await connection.execute(`UPDATE auth_grants SET revoked_at=? WHERE store_id=? ${userId ? 'AND user_id=?' : 'AND device_id=?'}`, [at, storeId, userId ?? deviceId]); },
    replay: (id) => one<AuthReplay>('auth_replays','AND operation_id=?',[id]), saveReplay: (value) => save('auth_replays', value, ['operation_id','store_id']),
  };
}
export function authUnitOfWork(store: MysqlStore): AuthDependencies['unitOfWork'] {
  const base = store.unitOfWork<AuthTransaction>((connection, core, active) => {
    const sql={active,forUpdate:' FOR UPDATE',all:async(query:string,values:unknown[]=[])=>{active();const [rows]=await connection.query<RowDataPacket[]>(query.endsWith(' FOR UPDATE')?query:`${query} FOR UPDATE`,values);return rows;},run:async(query:string,values:unknown[]=[])=>{active();await connection.query(query,values);}};
    const publication=publicationRepository(sql,store.identity.store_id),auth=mysqlAuthRepository(connection,store.identity.store_id,active,publication);
    return {auth:{...auth,installation:async()=>{await publication.lock();return auth.installation();}},audit:core.audit};
  });
  return { run: (work) => base.run(async (tx) => { await tx.auth.installation(); return work(tx); }) };
}
