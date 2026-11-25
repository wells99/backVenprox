import type { LocalGrant, LocalIdentityCache, PairedDevice } from '../../../application/src/local-auth.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { SqliteStore } from './store.js';

export function sqliteAuthCache(store: SqliteStore, protector: { protect(value: string): Promise<string>; unprotect(value: string): Promise<string> }): LocalIdentityCache {
  const uow = store.unitOfWork((db, _core, active) => ({ db, active }));
  const identity = store.identity;
  const loadGrant = (login: string) => uow.run(async ({ db, active }) => { active();
    return db.prepare('SELECT * FROM auth_local_grants WHERE store_id=? AND device_id=? AND login_key=?').get(identity.store_id, identity.device_id!, login) as { ciphertext: string; failures: number; locked_until: string | null; last_seen: string } | undefined;
  });
  return {
    device: async () => {
      const encrypted = await uow.run(async ({ db }) => (db.prepare('SELECT ciphertext FROM auth_local_device WHERE singleton=1 AND store_id=? AND device_id=?').get(identity.store_id,identity.device_id!) as {ciphertext:string}|undefined)?.ciphertext);
      return encrypted ? JSON.parse(await protector.unprotect(encrypted)) as PairedDevice : undefined;
    },
    saveDevice: async (value) => {
      if (value.store_id !== identity.store_id || value.device_id !== identity.device_id) throw new ApplicationError('DEVICE_SCOPE_MISMATCH','Escopo inválido.','forbidden');
      const encrypted = await protector.protect(JSON.stringify(value));
      await uow.run(async ({ db }) => { db.prepare('INSERT INTO auth_local_device VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET ciphertext=excluded.ciphertext').run(identity.store_id,identity.device_id!,encrypted); });
    },
    grant: async (login) => { const row = await loadGrant(login); return row ? JSON.parse(await protector.unprotect(row.ciphertext)) as LocalGrant : undefined; },
    saveGrant: async (value, at) => {
      const encrypted = await protector.protect(JSON.stringify(value));
      await uow.run(async ({ db }) => { db.prepare(`INSERT INTO auth_local_grants VALUES(?,?,?,?,?,0,NULL,?) ON CONFLICT(store_id,user_id) DO UPDATE SET login_key=excluded.login_key,ciphertext=excluded.ciphertext,failures=0,locked_until=NULL,last_seen=excluded.last_seen`)
        .run(value.user_id,identity.store_id,identity.device_id!,value.login_key,encrypted,at); });
    },
    reserveAttempt: async (login, at) => {
      const allowed = await uow.run(async ({ db }) => {
        const global = db.prepare('SELECT attempts,window_started FROM auth_local_limits WHERE store_id=? AND device_id=?').get(identity.store_id,identity.device_id!) as {attempts:number;window_started:string} | undefined;
        if (global && at < global.window_started) throw new ApplicationError('CLOCK_ROLLBACK_DETECTED','Confira o relógio do terminal.','forbidden');
        const recent = global && Date.parse(at) - Date.parse(global.window_started) < 300000;
        if (recent && global.attempts >= 30) return false;
        db.prepare('INSERT INTO auth_local_limits VALUES(?,?,?,?) ON CONFLICT(store_id,device_id) DO UPDATE SET attempts=excluded.attempts,window_started=excluded.window_started').run(identity.store_id,identity.device_id!,recent ? global.attempts + 1 : 1,recent ? global.window_started : at);
        const row = db.prepare('SELECT failures,locked_until FROM auth_local_grants WHERE store_id=? AND login_key=?').get(identity.store_id,login) as { failures:number; locked_until:string|null } | undefined;
        if (!row) return true;
        if (row.locked_until && row.locked_until > at) return false;
        const failures = row.locked_until ? 1 : row.failures + 1;
        db.prepare('UPDATE auth_local_grants SET failures=?,locked_until=? WHERE store_id=? AND login_key=?').run(failures, failures >= 5 ? new Date(Date.parse(at)+300000).toISOString() : null, identity.store_id,login);
        return true;
      });
      if (!allowed) throw new ApplicationError('OFFLINE_RATE_LIMITED','Aguarde antes de tentar novamente.','rate_limited',true,300);
    },
    seen: (login, at) => uow.run(async ({ db }) => { db.prepare('UPDATE auth_local_grants SET last_seen=?,failures=0,locked_until=NULL WHERE store_id=? AND login_key=? AND last_seen<=?').run(at,identity.store_id,login,at); }),
    lastSeen: async (login) => (await loadGrant(login))?.last_seen,
  };
}
