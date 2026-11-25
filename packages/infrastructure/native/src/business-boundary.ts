import { Value } from 'typebox/value';
import { businessIpcCommands, type BusinessIpcCommand } from '../../../contracts/src/catalog-stock.js';
import { withinPayloadLimits } from '../../../contracts/src/common.js';
import { ApplicationError } from '../../../application/src/application-error.js';
import type { TrustedFrame } from './identity-boundary.js';
// O host nativo fornece o remetente real; renderer não pode escolher loja/usuário/permissões.
export function boundBusinessHandler(windowId:number,entryUrl:string,dispatch:(command:BusinessIpcCommand)=>Promise<unknown>){
  const expected=new URL(entryUrl);expected.hash='';
  return async(sender:TrustedFrame,command:unknown)=>{
    let frame:URL;
    try{frame=new URL(sender.frameUrl);frame.hash='';}catch{throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem IPC inválida.','forbidden');}
    if(sender.webContentsId!==windowId||!sender.mainFrame||frame.href!==expected.href)throw new ApplicationError('IPC_ORIGIN_REJECTED','Origem IPC inválida.','forbidden');
    if(!withinPayloadLimits(command)||!Value.Check(businessIpcCommands,command))throw new ApplicationError('INVALID_COMMAND','Comando IPC inválido.','content');
    return dispatch(command);
  };
}
