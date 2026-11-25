import { closeSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { RuntimeDiagnosticsRepository } from '../../../application/src/ports.js';

export function openSqliteRuntime(databasePath: string) {
  let lockPath: string | undefined;
  let lockFd: number | undefined;
  let database: Database.Database | undefined;
  try {
    const resolvedPath = databasePath === ':memory:' ? databasePath : realpathSync(databasePath);
    if (resolvedPath !== ':memory:') {
      // Sem remoção automática de lock antigo: recuperação exige verificar o processo anterior.
      lockPath = `${resolvedPath}.owner.lock`;
      lockFd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(lockFd, String(process.pid));
    }
    database = new Database(resolvedPath, { fileMustExist: resolvedPath !== ':memory:', timeout: 3000 });
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    const { version } = database.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
    // Baseline conservadora: não aceitar WAL anterior à correção 3.51.3.
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
      throw new Error('UNSUPPORTED_SQLITE_RUNTIME');
    }
    const repository: RuntimeDiagnosticsRepository = {
      inspect: () => ({
        engine: 'sqlite',
        engine_version: version,
        storage_mode: resolvedPath === ':memory:' ? 'ephemeral' : 'existing_file',
      }),
    };
    let closed = false;
    return {
      repository,
      close() {
        if (closed) return;
        database?.close();
        if (lockFd !== undefined && lockPath) {
          closeSync(lockFd);
          unlinkSync(lockPath);
        }
        closed = true;
      },
    };
  } catch (error) {
    database?.close();
    if (lockFd !== undefined && lockPath) {
      closeSync(lockFd);
      unlinkSync(lockPath);
    }
    throw error;
  }
}
