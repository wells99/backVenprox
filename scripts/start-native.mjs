import {spawn} from 'node:child_process';
import electron from 'electron';
const child=spawn(electron,['dist/apps/native/src/main.js'],{stdio:'inherit',windowsHide:process.env.VENPROX_QA_HIDDEN==='true',env:{...process.env,VENPROX_NODE_PATH:process.execPath}});
child.on('exit',(code)=>{process.exitCode=code??1;});
