import type { AuthorizedContext, Permission, Role } from '../../domain/src/authorization.js';
import type { Audit, Clock, IdGenerator, UnitOfWork } from './ports.js';

export interface Installation { store_id: string; setup_hash: string; setup_expires: string; activated_at: string | null; store_name: string; offline_ttl_seconds: number; next_device_code: number }
export interface AuthUser { id: string; store_id: string; login_key: string; name: string; password_hash: string; role: Role; active: boolean; permissions_version: number; version: number }
export interface AuthSession { id: string; store_id: string; user_id: string; access_hash: string; refresh_hash: string; csrf_hash: string; access_expires: string; refresh_expires: string; revoked_at: string | null }
export interface AuthDevice { id: string; store_id: string; code: string; credential_hash: string; active: boolean; version: number }
export interface AuthInvite { id: string; store_id: string; token_hash: string; expires_at: string; used_at: string | null }
export interface AuthLimit { bucket: string; store_id: string; attempts: number; window_started: string }
export interface AuthGrant { id: string; store_id: string; user_id: string; device_id: string; issued_at: string; expires_at: string; permissions_version: number; revoked_at: string | null }
export interface AuthReplay { operation_id: string; store_id: string; actor_id: string; command_hash: string; result_json: string }
export interface AuthRepository {
  installation(): Promise<Installation>; saveInstallation(value: Installation): Promise<void>;
  user(id: string): Promise<AuthUser | undefined>; userByLogin(login: string): Promise<AuthUser | undefined>; users(): Promise<AuthUser[]>; saveUser(value: AuthUser): Promise<void>;
  sessionByAccess(hash: string): Promise<AuthSession | undefined>; sessionByRefresh(hash: string): Promise<AuthSession | undefined>; saveSession(value: AuthSession): Promise<void>; revokeUserSessions(userId: string, at: string): Promise<void>;
  device(id: string): Promise<AuthDevice | undefined>; deviceByCredential(hash: string): Promise<AuthDevice | undefined>; devices(): Promise<AuthDevice[]>; saveDevice(value: AuthDevice): Promise<void>;
  inviteByHash(hash: string): Promise<AuthInvite | undefined>; saveInvite(value: AuthInvite): Promise<void>;
  limit(bucket: string): Promise<AuthLimit | undefined>; saveLimit(value: AuthLimit): Promise<void>;
  rolePermissions(role: Role): Promise<Permission[]>;
  saveGrant(value: AuthGrant): Promise<void>; revokeGrants(userId: string | null, deviceId: string | null, at: string): Promise<void>;
  replay(id: string): Promise<AuthReplay | undefined>; saveReplay(value: AuthReplay): Promise<void>;
}
export interface AuthTransaction { auth: AuthRepository; audit: Audit }
export interface AuthCrypto {
  hashPassword(password: string): Promise<string>; verifyPassword(hash: string, password: string): Promise<boolean>;
  token(): string; digest(value: string): string; fingerprint(value: string): string;
  signGrant(context: AuthorizedContext): string; verifyGrant(token: string, publicKey: string): AuthorizedContext;
  publicKey(): string;
}
export interface AuthDependencies { unitOfWork: UnitOfWork<AuthTransaction>; crypto: AuthCrypto; clock: Clock; ids: IdGenerator; storeId: string }
