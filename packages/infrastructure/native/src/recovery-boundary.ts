import { Value } from 'typebox/value';
import { recoveryCommands,type RecoveryCommand } from '../../../contracts/src/recovery.js';
import { withinPayloadLimits } from '../../../contracts/src/common.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { TrustedFrame } from './identity-boundary.js';
export function boundRecoveryHandler(windowId:number,entryUrl:string,dispatch:(c:RecoveryCommand)=>Promise<unknown>){const expected=new URL(entryUrl);expected.hash='';return async(sender:TrustedFrame,command:unknown)=>{let url:URL;try{url=new URL(sender.frameUrl);url.hash='';}catch{throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem inválida.','forbidden');}if(sender.webContentsId!==windowId||!sender.mainFrame||url.href!==expected.href)throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem inválida.','forbidden');if(!withinPayloadLimits(command)||!Value.Check(recoveryCommands,command))throw new ApplicationError('INVALID_COMMAND','Comando de manutenção inválido.','content');return dispatch(command);};}
