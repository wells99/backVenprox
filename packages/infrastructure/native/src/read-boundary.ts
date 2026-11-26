import { Value } from 'typebox/value';
import { readCommands,type ReadCommand } from '../../../contracts/src/reads.js';
import { withinPayloadLimits } from '../../../contracts/src/common.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { TrustedFrame } from './identity-boundary.js';
export function boundReadHandler(windowId:number,entryUrl:string,dispatch:(c:ReadCommand)=>Promise<unknown>){const expected=new URL(entryUrl);expected.hash='';return async(sender:TrustedFrame,command:unknown)=>{let url:URL;try{url=new URL(sender.frameUrl);url.hash='';}catch{throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem inválida.','forbidden');}if(sender.webContentsId!==windowId||!sender.mainFrame||url.href!==expected.href)throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem inválida.','forbidden');if(!withinPayloadLimits(command)||!Value.Check(readCommands,command))throw new ApplicationError('INVALID_COMMAND','Consulta inválida.','content');return dispatch(command);};}
