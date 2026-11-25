import type { AuthorizedContext } from '../../domain/src/authorization.js';
import type { Clock } from './ports.js';
import type { AuthCrypto } from './auth-ports.js';
import { ApplicationError } from './application-error.js';

export interface PairedDevice { device_id: string; store_id: string; code: string; device_credential: string; grant_public_key: string; offline_enabled?: boolean; session?: { cookies: string; csrf: string } }
export interface LocalGrant { user_id: string; login_key: string; password_hash: string; authorization: string }
export interface LocalIdentityCache {
  device(): Promise<PairedDevice | undefined>; saveDevice(value: PairedDevice): Promise<void>;
  grant(login: string): Promise<LocalGrant | undefined>; saveGrant(value: LocalGrant, at: string): Promise<void>;
  reserveAttempt(login: string, at: string): Promise<void>; seen(login: string, at: string): Promise<void>;
  lastSeen(login: string): Promise<string | undefined>;
  proof?(authorizationId:string):Promise<string|undefined>;
}
export interface RemoteIdentityGateway {
  enroll(token: string, deviceId: string): Promise<PairedDevice>;
  login(login: string, password: string, device: PairedDevice): Promise<{ context: AuthorizedContext; device: PairedDevice; authorization?: string }>;
  logout(device: PairedDevice): Promise<void>;
}
export class LocalAuthService {
  private current: { context: AuthorizedContext; login: string } | undefined;
  private readonly dummyHash: Promise<string>;
  constructor(private readonly options: { storeId: string; deviceId: string; cache: LocalIdentityCache; gateway: RemoteIdentityGateway;
    crypto: Pick<AuthCrypto,'hashPassword'|'verifyPassword'|'verifyGrant'>; clock: Clock }) { this.dummyHash = options.crypto.hashPassword('offline-dummy-not-an-account'); }
  private now() { return this.options.clock.now().toISOString(); }
  private scope(device: PairedDevice) {
    if (device.store_id !== this.options.storeId || device.device_id !== this.options.deviceId) throw new ApplicationError('DEVICE_SCOPE_MISMATCH', 'Terminal pertence a outra instalação.', 'forbidden');
  }
  private async paired() {
    const device = await this.options.cache.device();
    if (!device) throw new ApplicationError('DEVICE_NOT_PAIRED', 'Terminal ainda não pareado.', 'unauthenticated');
    this.scope(device); return device;
  }
  async enroll(invitation: string) {
    if (await this.options.cache.device()) throw new ApplicationError('DEVICE_ALREADY_PAIRED', 'Terminal já pareado.', 'conflict');
    const device = await this.options.gateway.enroll(invitation, this.options.deviceId); this.scope(device);
    await this.options.cache.saveDevice(device);
    return this.deviceStatus();
  }
  async deviceStatus() {
    const device = await this.options.cache.device();
    if (device) this.scope(device);
    return { paired: Boolean(device), device_id: this.options.deviceId, store_id: this.options.storeId,
      ...(device ? { code: device.code } : {}), offline_enabled: device?.offline_enabled ?? false };
  }
  async loginOnline(login: string, password: string) {
    const device = await this.paired();
    const result = await this.options.gateway.login(login, password, device);
    this.scope(result.device);
    if (result.context.store_id !== this.options.storeId) throw new ApplicationError('AUTH_SCOPE_MISMATCH', 'Escopo inválido.', 'forbidden');
    await this.options.cache.saveDevice(result.device);
    if (result.authorization) {
      const context = this.options.crypto.verifyGrant(result.authorization, device.grant_public_key);
      if (context.user_id !== result.context.user_id || context.store_id !== this.options.storeId || context.device_id !== this.options.deviceId || context.expires_at <= this.now()) throw new ApplicationError('OFFLINE_AUTHORIZATION_INVALID', 'Autorização inválida.', 'forbidden');
      await this.options.cache.saveGrant({ user_id: context.user_id, login_key: login, password_hash: await this.options.crypto.hashPassword(password), authorization: result.authorization }, this.now());
    }
    this.current = { context: { ...result.context, device_id: this.options.deviceId }, login };
    return { context: this.current.context };
  }
  async loginOffline(login: string, password: string) {
    const device = await this.paired();
    if (!device.offline_enabled) throw new ApplicationError('OFFLINE_DISABLED','Acesso offline ainda não habilitado para esta loja.','conflict');
    await this.options.cache.reserveAttempt(login, this.now());
    const grant = await this.options.cache.grant(login);
    const verified = await this.options.crypto.verifyPassword(grant?.password_hash ?? await this.dummyHash, password);
    if (!grant || !verified) throw new ApplicationError('INVALID_OFFLINE_CREDENTIALS', 'Acesso offline não autorizado para este usuário.', 'unauthenticated');
    const context = this.options.crypto.verifyGrant(grant.authorization, device.grant_public_key);
    const seen = await this.options.cache.lastSeen(login);
    if (seen && this.now() < seen || context.authorized_at > this.now()) throw new ApplicationError('CLOCK_ROLLBACK_DETECTED', 'Confira o relógio do terminal antes de continuar.', 'forbidden');
    if (context.store_id !== this.options.storeId || context.device_id !== this.options.deviceId || context.user_id !== grant.user_id || context.expires_at <= this.now()) throw new ApplicationError('OFFLINE_AUTHORIZATION_EXPIRED', 'É necessário renovar a autorização online.', 'unauthenticated');
    await this.options.cache.seen(login, this.now());
    this.current = { context, login }; return { context };
  }
  async getContext() {
    if (!this.current || this.current.context.expires_at <= this.now()) throw new ApplicationError('AUTHENTICATION_REQUIRED', 'Autenticação necessária.', 'unauthenticated');
    const seen = await this.options.cache.lastSeen(this.current.login);
    if (seen && this.now() < seen) throw new ApplicationError('CLOCK_ROLLBACK_DETECTED', 'Confira o relógio do terminal.', 'forbidden');
    if (this.current.context.authorization_origin === 'offline') await this.options.cache.seen(this.current.login, this.now());
    return { context: this.current.context };
  }
  async logout() {
    this.current = undefined;
    const device = await this.options.cache.device();
    if (device?.session) {
      try { await this.options.gateway.logout(device); } catch { /* Logout local não depende de rede; expiração remota continua limitada. */ }
      const { session: _session, ...paired } = device;
      await this.options.cache.saveDevice(paired);
    }
    return { ok: true as const };
  }
}
