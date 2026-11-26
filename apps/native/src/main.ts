import { boundRecoveryHandler } from '../../../packages/infrastructure/native/src/recovery-boundary.js';
import { recoveryCommands } from '../../../packages/contracts/src/recovery.js';
import { app,BrowserWindow,ipcMain } from 'electron';
import { fork,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {mkdirSync} from 'node:fs';
import { Value } from 'typebox/value';
import { boundIdentityHandler } from '../../../packages/infrastructure/native/src/identity-boundary.js';
import { boundBusinessHandler } from '../../../packages/infrastructure/native/src/business-boundary.js';
import { boundSyncHandler } from '../../../packages/infrastructure/native/src/sync-boundary.js';
import { boundReadHandler } from '../../../packages/infrastructure/native/src/read-boundary.js';
import { authIpcCommands } from '../../../packages/contracts/src/auth.js';
import { businessIpcCommands } from '../../../packages/contracts/src/catalog-stock.js';
import { localSyncCommands } from '../../../packages/contracts/src/local-sync.js';
import { readCommands } from '../../../packages/contracts/src/reads.js';
import { errorResponse,withinPayloadLimits } from '../../../packages/contracts/src/common.js';
import { ApplicationError } from '../../../packages/application/src/application-error.js';
const pending=new Map<string,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
let child:ChildProcess|undefined,stopping=false,closed=false;
function stopped(){for(const [id,p]of pending){clearTimeout(p.timer);p.resolve(errorResponse('LOCAL_SERVICE_UNAVAILABLE','Serviço local indisponível; a intenção foi preservada.',id,[],true));}pending.clear();}
async function close(){if(closed||stopping)return;stopping=true;try{if(child?.connected){const exited=once(child,'exit');child.send({type:'shutdown',request_id:randomUUID()});await Promise.race([exited,new Promise<void>((r)=>setTimeout(r,12000))]);if(child.exitCode===null)child.kill();}}finally{stopped();closed=true;app.quit();}}
async function start(){try{
 app.setName('Venprox');const profile=process.env.VENPROX_UI_DATA_DIRECTORY??resolve(process.env.LOCALAPPDATA??app.getPath('appData'),'Venprox','interface');mkdirSync(profile,{recursive:true});app.setPath('userData',profile);if(!app.requestSingleInstanceLock()){app.quit();return;}app.on('second-instance',()=>{const existing=BrowserWindow.getAllWindows()[0];if(existing){if(existing.isMinimized())existing.restore();if(process.env.VENPROX_QA_HIDDEN!=='true')existing.show();existing.focus();}});
 await app.whenReady();
 const node=process.env.VENPROX_NODE_PATH;if(!node)throw new Error('NODE_RUNTIME_REQUIRED');
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MYSQL_')&&!['AUTH_INSTALLATION_TOKEN','AUTH_SIGNING_KEY_FILE','AUTH_FINGERPRINT_KEY','AUTH_ENABLED','ELECTRON_RUN_AS_NODE','VENPROX_NODE_PATH'].includes(key)));
 child=fork(resolve('dist/apps/local-service/src/main.js'),[],{execPath:node,execArgv:['--use-system-ca'],env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 child.on('message',(value:unknown)=>{if(!value||typeof value!=='object')return;const r=value as {meta?:{request_id?:string};error?:{request_id?:string}};const id=r.meta?.request_id??r.error?.request_id;if(!id)return;const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);p.resolve(value);}});child.once('exit',stopped);
 const [ready]=await once(child,'message',{signal:AbortSignal.timeout(15000)});if(ready.type!=='ready')throw new Error('LOCAL_STARTUP_FAILED');
 const entry=pathToFileURL(resolve('../front-Venprox/dist/index.html')).href;
 const window=new BrowserWindow({width:1360,height:900,minWidth:1000,minHeight:700,show:process.env.VENPROX_QA_HIDDEN!=='true',backgroundColor:'#f7faf7',webPreferences:{preload:resolve('apps/native/preload.cjs'),offscreen:process.env.VENPROX_QA_HIDDEN==='true',backgroundThrottling:process.env.VENPROX_QA_HIDDEN!=='true',contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,webviewTag:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{const target=new URL(url);target.hash='';if(target.href!==entry)event.preventDefault();});window.webContents.on('will-attach-webview',(event)=>event.preventDefault());window.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
 window.webContents.session.webRequest.onHeadersReceived((details,callback)=>{if(!details.url.startsWith('file:')){callback({responseHeaders:details.responseHeaders??{}});return;}callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"]}});});
 const dispatch=(command:unknown)=>new Promise<unknown>((done)=>{const id=(command as {request_id:string}).request_id;if(!child?.connected){done(errorResponse('LOCAL_SERVICE_UNAVAILABLE','Serviço local indisponível.',id,[],true));return;}const timer=setTimeout(()=>{pending.delete(id);done(errorResponse('LOCAL_RESPONSE_UNCERTAIN','Resposta ainda não confirmada. Preserve a intenção e consulte o resultado.',id,[],true));},20000);pending.set(id,{resolve:done,timer});child.send(command as object);});
 const auth=boundIdentityHandler(window.webContents.id,entry,dispatch),business=boundBusinessHandler(window.webContents.id,entry,dispatch),sync=boundSyncHandler(window.webContents.id,entry,dispatch),reads=boundReadHandler(window.webContents.id,entry,dispatch),recovery=boundRecoveryHandler(window.webContents.id,entry,dispatch);
 ipcMain.handle('venprox:command',async(event,value:unknown)=>{const id=randomUUID();try{if(!value||typeof value!=='object'||!withinPayloadLimits(value))throw new ApplicationError('INVALID_COMMAND','Comando inválido.','content');const command={...value,request_id:id},sender={webContentsId:event.sender.id,mainFrame:event.senderFrame===event.sender.mainFrame,frameUrl:event.senderFrame?.url??''};if(Value.Check(authIpcCommands,command))return await auth(sender,command);if(Value.Check(businessIpcCommands,command))return await business(sender,command);if(Value.Check(localSyncCommands,command))return await sync(sender,command);if(Value.Check(readCommands,command))return await reads(sender,command);if(Value.Check(recoveryCommands,command))return await recovery(sender,command);throw new ApplicationError('INVALID_COMMAND','Comando inválido.','content');}catch(error){return errorResponse(error instanceof ApplicationError?error.code:'IPC_UNAVAILABLE','Não foi possível concluir o comando.',id,[],false);}});
 await window.loadURL(entry);if(process.env.VENPROX_QA_HIDDEN!=='true'){window.show();window.focus();}window.on('closed',()=>{void close();});app.on('before-quit',(event)=>{if(!closed){event.preventDefault();void close();}});
}catch{stopped();if(child?.connected)child.send({type:'shutdown',request_id:randomUUID()});console.error('NATIVE_STARTUP_FAILED');app.exit(1);}}
const startup=start();
// The development launcher owns this optional IPC channel. Finish boot before
// closing so its interruption cannot strand the SQLite writer lock mid-startup.
if(process.connected)process.once('disconnect',()=>{void startup.then(close);});
