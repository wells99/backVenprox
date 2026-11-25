import { Value } from 'typebox/value';
import { AuthResponse, EnrollmentResponse, OfflineGrantResponse } from '../../../contracts/src/auth.js';
import type { PairedDevice, RemoteIdentityGateway } from '../../../application/src/local-auth.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { AuthorizedContext } from '../../../domain/src/authorization.js';

export function identityGateway(origin: string): RemoteIdentityGateway {
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('INVALID_IDENTITY_ORIGIN');
  async function request(path: string, body: object, headers: Record<string,string> = {}) {
    try {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type':'application/json', origin, ...headers },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
      const text = await response.text();
      if (text.length > 65536) throw new Error();
      const data: unknown = JSON.parse(text);
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'code' in data.error ? String(data.error.code) : 'REMOTE_AUTH_FAILED';
        if (code === 'OFFLINE_DISABLED') throw new ApplicationError(code,'Acesso offline desativado.','conflict');
        throw new ApplicationError(response.status === 401 ? 'INVALID_CREDENTIALS' : 'REMOTE_AUTH_FAILED','Não foi possível autorizar o acesso online.',response.status === 401 ? 'unauthenticated' : response.status === 429 ? 'rate_limited' : 'forbidden');
      }
      return { data, response };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('IDENTITY_SERVER_UNAVAILABLE','Não foi possível acessar o servidor de identidade.','unavailable',true);
    }
  }
  return {
    enroll: async (token, deviceId) => {
      const result = await request('/api/v1/devices/enroll',{ invitation_token: token, device_id: deviceId });
      if (!Value.Check(EnrollmentResponse,result.data)) throw new ApplicationError('REMOTE_CONTRACT_INVALID','Resposta de pareamento inválida.','unavailable');
      return { ...result.data.data, offline_enabled: false };
    },
    login: async (login, password, device) => {
      const result = await request('/api/v1/auth/login',{login,password});
      if (!Value.Check(AuthResponse,result.data)) throw new ApplicationError('REMOTE_CONTRACT_INVALID','Resposta de autenticação inválida.','unavailable');
      const cookies = result.response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]!).join('; ');
      if (!cookies.includes('venprox_access=') || !cookies.includes('venprox_refresh=')) throw new ApplicationError('REMOTE_CONTRACT_INVALID','Sessão inválida.','unavailable');
      const paired: PairedDevice = { ...device, session: { cookies, csrf: result.data.data.csrf_token }, offline_enabled: false };
      let authorization: string | undefined;
      try {
        const grant = await request('/api/v1/auth/offline-grant',{}, { cookie: cookies, 'x-csrf-token': paired.session!.csrf, 'x-device-credential': device.device_credential });
        if (!Value.Check(OfflineGrantResponse,grant.data)) throw new ApplicationError('REMOTE_CONTRACT_INVALID','Resposta de autorização inválida.','unavailable');
        authorization = grant.data.data.authorization; paired.offline_enabled = true;
      } catch (error) { if (!(error instanceof ApplicationError) || error.code !== 'OFFLINE_DISABLED') throw error; }
      return { context: result.data.data.context as AuthorizedContext, device: paired, ...(authorization ? { authorization } : {}) };
    },
    logout: async (device) => { if (device.session) await request('/api/v1/auth/logout',{}, {cookie:device.session.cookies,'x-csrf-token':device.session.csrf}); },
  };
}
