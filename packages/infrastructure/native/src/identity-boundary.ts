import { Value } from 'typebox/value';
import { authIpcCommands, type AuthIpcCommand } from '../../../contracts/src/auth.js';
import { ApplicationError } from '../../../application/src/application-error.js';

export interface TrustedFrame { webContentsId: number; mainFrame: boolean; frameUrl: string }
// A futura composição Electron fornece estes dados a partir do evento, nunca do payload do renderer.
export function boundIdentityHandler(windowId: number, entryUrl: string, dispatch: (command: AuthIpcCommand) => Promise<unknown>) {
  const expected = new URL(entryUrl); expected.hash = '';
  return async (sender: TrustedFrame, command: unknown) => {
    let frame: URL;
    try { frame = new URL(sender.frameUrl); frame.hash = ''; }
    catch { throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem IPC inválida.','forbidden'); }
    if (sender.webContentsId !== windowId || !sender.mainFrame || frame.href !== expected.href) throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem IPC inválida.','forbidden');
    if (!Value.Check(authIpcCommands,command)) throw new ApplicationError('INVALID_COMMAND','Comando IPC inválido.','content');
    return dispatch(command);
  };
}
