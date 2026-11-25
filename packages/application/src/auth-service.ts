import { ApplicationError } from './application-error.js';
import type { AuthDependencies, AuthRepository, AuthSession, AuthTransaction, AuthUser } from './auth-ports.js';
import type { AuthorizedContext, Permission, Role } from '../../domain/src/authorization.js';

export const publicUser = (user: AuthUser) => ({ id: user.id, login: user.login_key, name: user.name, role: user.role,
  active: user.active, permissions_version: user.permissions_version, version: user.version });
const denied = () => new ApplicationError('AUTHENTICATION_REQUIRED', 'Autenticação necessária.', 'unauthenticated');
const invalid = () => new ApplicationError('INVALID_CREDENTIALS', 'Usuário ou senha inválidos.', 'unauthenticated');
const conflict = (code: string) => new ApplicationError(code, 'A operação conflita com o estado atual.', 'conflict');
export class AuthService {
  private readonly dummyHash: Promise<string>;
  private readonly serverDeviceId: string;
  constructor(private readonly deps: AuthDependencies) { this.serverDeviceId=deps.ids.generate(); this.dummyHash = deps.crypto.hashPassword(deps.crypto.token()); }
  private now() { return this.deps.clock.now().toISOString(); }
  private after(seconds: number) { return new Date(this.deps.clock.now().getTime() + seconds * 1000).toISOString(); }
  private async audit(tx: AuthTransaction, action: string, operationId = this.deps.ids.generate(), deviceId?: string,
    actor?: {user_id?:string;permissions_version?:number;authorization_id:string;authorization_origin:'online'|'offline'|'setup'|'invitation'}) {
    await tx.audit.append({ operation_id: operationId, store_id: this.deps.storeId, device_id: deviceId ?? this.serverDeviceId, occurred_at: this.now(), action,
      ...(actor ? {authorization_id:actor.authorization_id,authorization_origin:actor.authorization_origin,
        ...(actor.user_id?{actor_user_id:actor.user_id}:{}),...(actor.permissions_version===undefined?{}:{permissions_version:actor.permissions_version})} : {}) });
  }
  private async reserve(repo: AuthRepository, bucket: string, maximum: number) {
    const id = this.deps.crypto.digest(bucket);
    const previous = await repo.limit(id);
    const recent = previous && this.deps.clock.now().getTime() - Date.parse(previous.window_started) < 900_000;
    if (recent && previous.attempts >= maximum) return false;
    await repo.saveLimit({ bucket: id, store_id: this.deps.storeId, attempts: recent ? previous.attempts + 1 : 1, window_started: recent ? previous.window_started : this.now() });
    return true;
  }
  private async context(repo: AuthRepository, session: AuthSession | undefined): Promise<AuthorizedContext> {
    if (!session || session.revoked_at || session.access_expires <= this.now() || session.store_id !== this.deps.storeId) throw denied();
    const user = await repo.user(session.user_id);
    if (!user?.active || user.store_id !== this.deps.storeId) throw denied();
    return { store_id: user.store_id, user_id: user.id, device_id: null, permissions: await repo.rolePermissions(user.role), permissions_version: user.permissions_version,
      authorization_id: session.id, authorization_origin: 'online', authorized_at: this.now(), expires_at: session.access_expires };
  }
  private async require(repo: AuthRepository, access: string, permission?: Permission) {
    const context = await this.context(repo, await repo.sessionByAccess(this.deps.crypto.digest(access)));
    if (permission && !context.permissions.includes(permission)) throw new ApplicationError('PERMISSION_DENIED', 'Permissão insuficiente.', 'forbidden');
    return context;
  }
  async authenticate(access: string) { return this.deps.unitOfWork.run((tx) => this.require(tx.auth, access)); }
  async activate(input: { installation_token: string; store_name: string; login: string; name: string; password: string }, ip: string) {
    const admitted = await this.deps.unitOfWork.run(async ({ auth }) => {
      if (!await this.reserve(auth, `setup:${ip}`, 10)) return false;
      const installation = await auth.installation();
      return !installation.activated_at && installation.setup_expires > this.now() && installation.setup_hash === this.deps.crypto.digest(input.installation_token);
    });
    if (!admitted) throw new ApplicationError('SETUP_UNAVAILABLE', 'Ativação indisponível ou autorização inválida.', 'forbidden');
    const hash = await this.deps.crypto.hashPassword(input.password);
    const userId = this.deps.ids.generate();
    return this.deps.unitOfWork.run(async (tx) => {
      const installation = await tx.auth.installation();
      if (installation.activated_at || installation.setup_expires <= this.now() || installation.setup_hash !== this.deps.crypto.digest(input.installation_token)) throw conflict('SETUP_ALREADY_COMPLETED');
      const user: AuthUser = { id: userId, store_id: this.deps.storeId, login_key: input.login, name: input.name, password_hash: hash, role: 'admin', active: true, permissions_version: 1, version: 1 };
      await tx.auth.saveUser(user);
      await tx.auth.saveInstallation({ ...installation, activated_at: this.now(), setup_hash: '', store_name: input.store_name });
      await this.audit(tx, 'setup.activated',undefined,undefined,{user_id:user.id,permissions_version:1,authorization_id:this.deps.storeId,authorization_origin:'setup'});
      return publicUser(user);
    });
  }
  async login(login: string, password: string, ip: string) {
    const candidate = await this.deps.unitOfWork.run(async ({ auth }) => {
      const allowedIp = await this.reserve(auth, `login-ip:${ip}`, 30);
      if(!allowedIp)return {limited:true,user:undefined};
      const allowedUser = await this.reserve(auth, `login-user:${login}`, 10);
      return { limited: !allowedIp || !allowedUser, user: allowedIp && allowedUser ? await auth.userByLogin(login) : undefined };
    });
    if (candidate.limited) throw new ApplicationError('AUTH_RATE_LIMITED', 'Aguarde antes de tentar novamente.', 'rate_limited', true, 900);
    const verified = await this.deps.crypto.verifyPassword(candidate.user?.password_hash ?? await this.dummyHash, password);
    if (!verified || !candidate.user?.active) throw invalid();
    const access = this.deps.crypto.token(), refresh = this.deps.crypto.token(), csrf = this.deps.crypto.token();
    const sessionId = this.deps.ids.generate();
    return this.deps.unitOfWork.run(async (tx) => {
      const user = await tx.auth.user(candidate.user!.id);
      if (!user?.active || user.password_hash !== candidate.user!.password_hash || user.version !== candidate.user!.version) throw invalid();
      const session: AuthSession = { id: sessionId, store_id: this.deps.storeId, user_id: user.id, access_hash: this.deps.crypto.digest(access), refresh_hash: this.deps.crypto.digest(refresh),
        csrf_hash: this.deps.crypto.digest(csrf), access_expires: this.after(900), refresh_expires: this.after(604800), revoked_at: null };
      await tx.auth.saveSession(session); const context=await this.context(tx.auth,session); await this.audit(tx, 'auth.login',undefined,undefined,context);
      await tx.auth.saveLimit({ bucket: this.deps.crypto.digest(`login-user:${login}`), store_id: this.deps.storeId, attempts: 0, window_started: this.now() });
      return { access, refresh, csrf, user: publicUser(user), context };
    });
  }
  async checkCsrf(access: string, csrf: string, refresh = false) {
    return this.deps.unitOfWork.run(async ({ auth }) => {
      const session = refresh ? await auth.sessionByRefresh(this.deps.crypto.digest(access)) : await auth.sessionByAccess(this.deps.crypto.digest(access));
      if (!session || session.revoked_at || session.refresh_expires <= this.now() || session.csrf_hash !== this.deps.crypto.digest(csrf)) throw new ApplicationError('CSRF_REJECTED', 'Origem ou autorização da requisição inválida.', 'forbidden');
    });
  }
  async refresh(refresh: string, csrf: string) {
    const accessToken = this.deps.crypto.token(), refreshToken = this.deps.crypto.token(), csrfToken = this.deps.crypto.token();
    return this.deps.unitOfWork.run(async (tx) => {
      const session = await tx.auth.sessionByRefresh(this.deps.crypto.digest(refresh));
      if (!session || session.revoked_at || session.refresh_expires <= this.now() || session.csrf_hash !== this.deps.crypto.digest(csrf)) throw denied();
      const user = await tx.auth.user(session.user_id);
      if (!user?.active) throw denied();
      const replacement = { ...session, access_hash: this.deps.crypto.digest(accessToken), refresh_hash: this.deps.crypto.digest(refreshToken), csrf_hash: this.deps.crypto.digest(csrfToken), access_expires: this.after(900) };
      await tx.auth.saveSession(replacement); const context=await this.context(tx.auth,replacement); await this.audit(tx, 'auth.refreshed',undefined,undefined,context);
      return { access: accessToken, refresh: refreshToken, csrf: csrfToken, user: publicUser(user), context };
    });
  }
  async logout(access: string) {
    await this.deps.unitOfWork.run(async (tx) => {
      const session = await tx.auth.sessionByAccess(this.deps.crypto.digest(access));
      if (session && !session.revoked_at) { await tx.auth.saveSession({ ...session, revoked_at: this.now() }); const user=await tx.auth.user(session.user_id); await this.audit(tx, 'auth.logout',undefined,undefined,{user_id:session.user_id,permissions_version:user?.permissions_version??1,authorization_id:session.id,authorization_origin:'online'}); }
    });
  }
  async me(access: string) {
    return this.deps.unitOfWork.run(async ({ auth }) => { const context = await this.require(auth, access); return { user: publicUser((await auth.user(context.user_id))!), context }; });
  }
  async users(access: string) { return this.deps.unitOfWork.run(async ({ auth }) => { await this.require(auth, access, 'users.manage'); return { items: (await auth.users()).map(publicUser) }; }); }
  private async replay<T>(tx: AuthTransaction, actorId: string, operationId: string, command: unknown, work: () => Promise<T>): Promise<T> {
    const digest = this.deps.crypto.fingerprint(JSON.stringify(command));
    const prior = await tx.auth.replay(operationId);
    if (prior) { if (prior.actor_id !== actorId || prior.command_hash !== digest) throw conflict('IDEMPOTENCY_CONFLICT'); return JSON.parse(prior.result_json) as T; }
    const result = await work();
    await tx.auth.saveReplay({ operation_id: operationId, store_id: this.deps.storeId, actor_id: actorId, command_hash: digest, result_json: JSON.stringify(result) });
    return result;
  }
  async createUser(access: string, input: { operation_id: string; login: string; name: string; password: string; role: Role }) {
    await this.deps.unitOfWork.run(({ auth }) => this.require(auth, access, 'users.manage'));
    const passwordHash = await this.deps.crypto.hashPassword(input.password);
    const id = this.deps.ids.generate();
    return this.deps.unitOfWork.run(async (tx) => {
      const actor = await this.require(tx.auth, access, 'users.manage');
      return this.replay(tx, actor.user_id, input.operation_id, { command: 'create-user', ...input }, async () => {
        if (await tx.auth.userByLogin(input.login)) throw conflict('LOGIN_UNAVAILABLE');
        const user: AuthUser = { id, store_id: this.deps.storeId, login_key: input.login, name: input.name, password_hash: passwordHash, role: input.role, active: true, permissions_version: 1, version: 1 };
        await tx.auth.saveUser(user); await this.audit(tx, 'user.created', input.operation_id,undefined,actor); return publicUser(user);
      });
    });
  }
  async updateUser(access: string, id: string, input: { operation_id: string; expected_version: number; name?: string; role?: Role; active?: boolean; password?: string }) {
    await this.deps.unitOfWork.run(({ auth }) => this.require(auth, access, 'users.manage'));
    const hash = input.password === undefined ? undefined : await this.deps.crypto.hashPassword(input.password);
    return this.deps.unitOfWork.run(async (tx) => {
      const actor = await this.require(tx.auth, access, 'users.manage');
      return this.replay(tx, actor.user_id, input.operation_id, { command: 'update-user', id, ...input }, async () => {
        const user = await tx.auth.user(id);
        if (!user) throw new ApplicationError('USER_NOT_FOUND', 'Usuário não encontrado.', 'not_found');
        if (user.version !== input.expected_version) throw conflict('VERSION_CONFLICT');
        const updated = { ...user, name: input.name ?? user.name, role: input.role ?? user.role, active: input.active ?? user.active,
          password_hash: hash ?? user.password_hash, version: user.version + 1, permissions_version: user.permissions_version + 1 };
        if (user.role === 'admin' && user.active && (updated.role !== 'admin' || !updated.active) && (await tx.auth.users()).filter((item) => item.role === 'admin' && item.active).length < 2) throw conflict('LAST_ADMIN_REQUIRED');
        await tx.auth.saveUser(updated); await tx.auth.revokeUserSessions(id, this.now()); await tx.auth.revokeGrants(id, null, this.now());
        await this.audit(tx, 'user.updated', input.operation_id,undefined,actor); return publicUser(updated);
      });
    });
  }
  async invitation(access: string) {
    const token = this.deps.crypto.token(), id = this.deps.ids.generate();
    return this.deps.unitOfWork.run(async (tx) => {
      const actor=await this.require(tx.auth, access, 'devices.manage');
      const expires = this.after(600);
      await tx.auth.saveInvite({ id, store_id: this.deps.storeId, token_hash: this.deps.crypto.digest(token), expires_at: expires, used_at: null });
      await this.audit(tx, 'device.invited',id,undefined,actor); return { invitation_token: token, expires_at: expires };
    });
  }
  async enroll(invitation: string, deviceId: string, ip: string) {
    const admitted = await this.deps.unitOfWork.run(({ auth }) => this.reserve(auth, `enroll:${ip}`, 10));
    if (!admitted) throw new ApplicationError('AUTH_RATE_LIMITED', 'Aguarde antes de tentar novamente.', 'rate_limited', true, 900);
    const credential = this.deps.crypto.token();
    return this.deps.unitOfWork.run(async (tx) => {
      const invite = await tx.auth.inviteByHash(this.deps.crypto.digest(invitation));
      if (!invite || invite.used_at || invite.expires_at <= this.now()) throw new ApplicationError('INVITATION_INVALID', 'Convite inválido ou expirado.', 'forbidden');
      if (await tx.auth.device(deviceId)) throw conflict('DEVICE_ALREADY_ENROLLED');
      const installation = await tx.auth.installation();
      if (!installation.activated_at) throw denied();
      const code = `CX${String(installation.next_device_code).padStart(2, '0')}`;
      await tx.auth.saveInstallation({ ...installation, next_device_code: installation.next_device_code + 1 });
      await tx.auth.saveDevice({ id: deviceId, store_id: this.deps.storeId, code, credential_hash: this.deps.crypto.digest(credential), active: true, version: 1 });
      await tx.auth.saveInvite({ ...invite, used_at: this.now() }); await this.audit(tx, 'device.enrolled', undefined, deviceId,{authorization_id:invite.id,authorization_origin:'invitation'});
      return { device_id: deviceId, store_id: this.deps.storeId, code, device_credential: credential, grant_public_key: this.deps.crypto.publicKey() };
    });
  }
  async devices(access: string) { return this.deps.unitOfWork.run(async ({ auth }) => { await this.require(auth, access, 'devices.manage'); return { items: (await auth.devices()).map(({ id, code, active, version }) => ({ id, code, active, version })) }; }); }
  async changeDevice(access: string, id: string, operationId: string, expectedVersion: number, rotate: boolean) {
    const credential = rotate ? this.deps.crypto.token() : '';
    return this.deps.unitOfWork.run(async (tx) => {
      let issued = false;
      const actor = await this.require(tx.auth, access, 'devices.manage');
      // Replay de rotação nunca republica segredo; usar novo convite em caso de perda da resposta.
      const result = await this.replay(tx, actor.user_id, operationId, { id, expectedVersion, rotate }, async () => {
        const device = await tx.auth.device(id);
        if (!device) throw new ApplicationError('DEVICE_NOT_FOUND', 'Terminal não encontrado.', 'not_found');
        if (device.version !== expectedVersion) throw conflict('VERSION_CONFLICT');
        await tx.auth.saveDevice({ ...device, active: rotate, credential_hash: rotate ? this.deps.crypto.digest(credential) : '', version: device.version + 1 });
        issued = rotate;
        await tx.auth.revokeGrants(null, id, this.now()); await this.audit(tx, rotate ? 'device.rotated' : 'device.revoked', operationId, id,actor);
        return { id, active: rotate, version: device.version + 1 };
      });
      return { ...result, ...(issued ? { device_credential: credential } : {}) };
    });
  }
  async offlineGrant(access: string, credential: string) {
    const grantId = this.deps.ids.generate();
    return this.deps.unitOfWork.run(async (tx) => {
      const context = await this.require(tx.auth, access);
      const device = await tx.auth.deviceByCredential(this.deps.crypto.digest(credential));
      if (!device?.active || device.store_id !== context.store_id) throw denied();
      const installation = await tx.auth.installation();
      if (installation.offline_ttl_seconds === 0) throw new ApplicationError('OFFLINE_DISABLED', 'Acesso offline ainda não habilitado para esta loja.', 'conflict');
      const authorized: AuthorizedContext = { ...context, device_id: device.id, authorization_id: grantId, authorization_origin: 'offline', authorized_at: this.now(), expires_at: this.after(installation.offline_ttl_seconds) };
      await tx.auth.saveGrant({ id: grantId, store_id: context.store_id, user_id: context.user_id, device_id: device.id, permissions_version: context.permissions_version,
        issued_at: authorized.authorized_at, expires_at: authorized.expires_at, revoked_at: null });
      await this.audit(tx, 'offline.authorized', undefined, device.id,context);
      return { authorization: this.deps.crypto.signGrant(authorized), expires_at: authorized.expires_at };
    });
  }
}
