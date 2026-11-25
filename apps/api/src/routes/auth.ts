import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthService } from '../../../../packages/application/src/auth-service.js';
import { ApplicationError } from '../../../../packages/application/src/application-error.js';
import { ErrorSchema, normalizeLoginKey, normalizeName, successSchema } from '../../../../packages/contracts/src/common.js';
import * as contracts from '../../../../packages/contracts/src/auth.js';

export type AuthHttpService = Pick<AuthService, keyof AuthService>;
export interface AuthHttpOptions { service: AuthHttpService; origin: string; secureCookies: boolean }
const security = [{ sessionCookie: [] }];
const errors = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 413: ErrorSchema, 422: ErrorSchema, 429: ErrorSchema, 500: ErrorSchema, 503: ErrorSchema };
export async function registerAuthRoutes(scope: FastifyInstance, options: AuthHttpOptions) {
  await scope.register(cookie);
  scope.addHook('onSend', async (_request, reply, payload) => { reply.header('cache-control','no-store'); return payload; });
  const router = scope.withTypeProvider<TypeBoxTypeProvider>();
  const service = options.service;
  const contextDto = (context: Awaited<ReturnType<AuthService['authenticate']>>) => ({ ...context, permissions: [...context.permissions] });
  const access = (request: FastifyRequest) => request.cookies.venprox_access ?? '';
  const wrap = <T>(data: T, request: FastifyRequest) => ({ data, meta: { request_id: request.id } });
  const mutation = async (request: FastifyRequest) => {
    if (request.headers.origin !== options.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new ApplicationError('ORIGIN_REJECTED', 'Origem da requisição inválida.', 'forbidden');
    if (!['/api/v1/auth/login','/api/v1/setup/activate','/api/v1/devices/enroll'].includes(request.routeOptions.url ?? '')) {
      const refresh = request.routeOptions.url === '/api/v1/auth/refresh';
      await service.checkCsrf(refresh ? request.cookies.venprox_refresh ?? '' : access(request), String(request.headers['x-csrf-token'] ?? ''), refresh);
    }
  };
  const cookieOptions = { path: '/', httpOnly: true, secure: options.secureCookies, sameSite: 'strict' as const };
  const base = (id: string, description: string, isPublic = false) => ({ tags: ['Identity'], operationId: id, description,
    security: isPublic ? [] : security, response: errors });
  const normalizeIdentity = <T extends { login: string; name?: string }>(body: T) => ({ ...body, login: normalizeLoginKey(body.login), ...(body.name === undefined ? {} : { name: normalizeName(body.name) }) });

  router.post('/api/v1/setup/activate', { preHandler: mutation, schema: { ...base('activateInstallation', 'Token temporário de uso único. POST cria um administrador (201); repetição não reabre setup. Senha 12–128 caracteres, preservada. Exige Origin configurada.', true), body: contracts.ActivateBody,
    response: { ...errors, 201: successSchema(contracts.UserSchema) } } }, async (request, reply) => {
    const user = await service.activate({ ...normalizeIdentity(request.body), store_name: normalizeName(request.body.store_name) }, request.ip);
    return reply.code(201).send(wrap(user, request));
  });
  router.post('/api/v1/auth/login', { preHandler: mutation, schema: { ...base('login', 'Sessão web por cookies HttpOnly/SameSite; Secure em produção. Limites persistentes por IP/login, erro genérico sem enumeração. Retorna nonce CSRF, nunca tokens de sessão no JSON.', true), body: contracts.LoginBody,
    response: { ...errors, 200: contracts.AuthResponse } } }, async (request, reply) => {
    const result = await service.login(normalizeLoginKey(request.body.login), request.body.password, request.ip);
    reply.setCookie('venprox_access', result.access, { ...cookieOptions, maxAge: 900 });
    reply.setCookie('venprox_refresh', result.refresh, { ...cookieOptions, maxAge: 604800 });
    return wrap({ user: result.user, context: contextDto(result.context), csrf_token: result.csrf }, request);
  });
  router.post('/api/v1/auth/refresh', { preHandler: mutation, schema: { ...base('refreshSession', 'Rotaciona acesso, refresh e CSRF; refresh é de uso único, com validade absoluta de sete dias. Exige Origin e X-CSRF-Token. Não é janela offline.'), body: contracts.EmptyBody,
    response: { ...errors, 200: contracts.AuthResponse } } }, async (request, reply) => {
    const result = await service.refresh(request.cookies.venprox_refresh ?? '', String(request.headers['x-csrf-token'] ?? ''));
    reply.setCookie('venprox_access', result.access, { ...cookieOptions, maxAge: 900 }); reply.setCookie('venprox_refresh', result.refresh, { ...cookieOptions, maxAge: 604800 });
    return wrap({ user: result.user, context: contextDto(result.context), csrf_token: result.csrf }, request);
  });
  router.post('/api/v1/auth/logout', { preHandler: mutation, schema: { ...base('logout', 'Revoga a sessão no servidor e apaga os cookies. Exige Origin e CSRF.'), body: contracts.EmptyBody, response: { ...errors, 200: contracts.OkResponse } } }, async (request, reply) => {
    await service.logout(access(request)); reply.clearCookie('venprox_access', cookieOptions); reply.clearCookie('venprox_refresh', cookieOptions); return wrap({ ok: true as const }, request);
  });
  router.get('/api/v1/auth/me', { schema: { ...base('currentUser', 'Usuário, permissões versionadas e contexto autorizado, sem hash/token privado.'), response: { ...errors, 200: contracts.MeResponse } } }, async (request) => {
    const result = await service.me(access(request)); return wrap({ user: result.user, context: contextDto(result.context) }, request);
  });
  router.get('/api/v1/admin/users', { schema: { ...base('listUsers', 'Permissão users.manage. Consulta até 100 usuários da loja da instalação.'), response: { ...errors, 200: contracts.UsersResponse } } }, async (request) => wrap(await service.users(access(request)), request));
  router.post('/api/v1/admin/users', { preHandler: mutation, schema: { ...base('createUser', 'Permissão users.manage. operation_id estável permite recuperar resultado sem duplicar. Login normalizado; senha preservada. Origin/CSRF obrigatórios.'), body: contracts.CreateUserBody,
    response: { ...errors, 201: successSchema(contracts.UserSchema) } } }, async (request, reply) => reply.code(201).send(wrap(await service.createUser(access(request), normalizeIdentity(request.body)), request)));
  router.patch('/api/v1/admin/users/:id', { preHandler: mutation, schema: { ...base('updateUser', 'Permissão users.manage, versão esperada e operation_id. Ausente preserva, null/vazio indevidos são rejeitados. Mudanças revogam sessões e concessões futuras; último admin ativo é preservado.'), params: contracts.IdParams, body: contracts.UpdateUserBody,
    response: { ...errors, 200: successSchema(contracts.UserSchema) } } }, async (request) => wrap(await service.updateUser(access(request), request.params.id,
      { ...request.body, ...(request.body.name === undefined ? {} : { name: normalizeName(request.body.name) }) }), request));
  router.post('/api/v1/admin/devices/invitations', { preHandler: mutation, schema: { ...base('inviteDevice', 'Permissão devices.manage. Convite válido por dez minutos, consumido uma vez. Enviar somente ao processo confiável do terminal.'), body: contracts.EmptyBody, response: { ...errors, 201: contracts.InvitationResponse } } }, async (request, reply) => reply.code(201).send(wrap(await service.invitation(access(request)), request)));
  router.post('/api/v1/devices/enroll', { preHandler: mutation, schema: { ...base('enrollDevice', 'Consome convite de uso único. Retorna credencial restrita e chave pública somente no pareamento, para armazenamento protegido do processo nativo; nunca dá permissão administrativa. Origin obrigatória.', true), body: contracts.EnrollBody, response: { ...errors, 201: contracts.EnrollmentResponse } } }, async (request, reply) => reply.code(201).send(wrap(await service.enroll(request.body.invitation_token, request.body.device_id, request.ip), request)));
  router.get('/api/v1/admin/devices', { schema: { ...base('listDevices', 'Permissão devices.manage; lista metadados até 100 terminais, sem credenciais.'), response: { ...errors, 200: contracts.DevicesResponse } } }, async (request) => wrap(await service.devices(access(request)), request));
  for (const rotate of [false, true]) {
    router.post(`/api/v1/admin/devices/:id/${rotate ? 'rotate' : 'revoke'}`, { preHandler: mutation, schema: { ...base(rotate ? 'rotateDevice' : 'revokeDevice', 'Permissão devices.manage, expected_version e operation_id. Revoga concessões futuras sem apagar fatos/outbox; offline não recebe revogação instantânea. Rotação entrega segredo só na primeira execução; replay retorna metadados.'), params: contracts.IdParams, body: contracts.VersionBody,
      response: { ...errors, 200: contracts.DeviceChangeResponse } } }, async (request) => wrap(await service.changeDevice(access(request), request.params.id, request.body.operation_id, request.body.expected_version, rotate), request));
  }
  router.post('/api/v1/auth/offline-grant', { preHandler: mutation, schema: { ...base('authorizeOffline', 'Usuário online e X-Device-Credential válido. Concessão assinada e vinculada à loja/usuário/terminal. Retorna OFFLINE_DISABLED enquanto a loja não definir prazo; nunca distribui hashes de senha.'), body: contracts.EmptyBody,
    response: { ...errors, 200: contracts.OfflineGrantResponse } } }, async (request) => wrap(await service.offlineGrant(access(request), String(request.headers['x-device-credential'] ?? '')), request));
}
