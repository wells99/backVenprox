import { mkdtemp,mkdir,writeFile,readFile,realpath,rm } from 'node:fs/promises';
import { join,dirname,basename,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const bundle=JSON.parse(await readFile('artifacts/desktop-latest.json','utf8')),manifest=JSON.parse(await readFile(join(bundle.directory,'distribution.json'),'utf8')),temporary=await mkdtemp(join(tmpdir(),'venprox-installed-qa-'));
try{
 const config=join(temporary,'Venprox/config'),data=join(temporary,'Venprox/data');await mkdir(config,{recursive:true});await mkdir(data,{recursive:true});await writeFile(join(config,'local.env'),'QA_PRESERVE_CONFIG=true\n');await writeFile(join(data,'preserved.marker'),'KEEP_EXISTING_DATA');
 await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(bundle.directory,'tools/Install-Venprox.ps1'),'-PackageDirectory',bundle.directory,'-NoShortcut'],{env:{...process.env,LOCALAPPDATA:temporary},windowsHide:true,timeout:180000});
 const installed=join(temporary,'Programs/Venprox',manifest.build_id);assert.equal(await readFile(join(config,'local.env'),'utf8'),'QA_PRESERVE_CONFIG=true\n');assert.equal(await readFile(join(data,'preserved.marker'),'utf8'),'KEEP_EXISTING_DATA');
 const log=resolve('artifacts/b19-installed-journey.log'),{open}=await import('node:fs/promises'),file=await open(log,'w');let code;
 try{const child=spawn(process.execPath,['--env-file=.env.b03','--import','tsx','--test','tests/frontend-journey.test.ts'],{cwd:process.cwd(),windowsHide:true,env:{...process.env,VENPROX_PACKAGE_DIRECTORY:installed,PATH:join(process.env.SystemRoot,'System32')+';'+join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0')},stdio:['ignore',file.fd,file.fd]});code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});}finally{await file.close();}
 assert.equal(code,0,'PACKAGED_JOURNEY_FAILED: see private artifacts/b19-installed-journey.log');await writeFile('artifacts/b19-installed-proof.json',JSON.stringify({build_id:manifest.build_id,installed_outside_repository:true,config_preserved:true,data_preserved:true,desktop_shortcut_modified:false,journey:true,node_npm_not_on_path:true,package_signed:false,sales_ui_regression:process.env.REGRESSION_SALES_UI==='true'}));console.log('Pacote instalado fora do repositório; configuração/dados preservados e jornada real aprovada sem Node/npm no PATH.');
}finally{assert.equal(await realpath(dirname(temporary)),await realpath(tmpdir()));assert.ok(basename(temporary).startsWith('venprox-installed-qa-'));await rm(temporary,{recursive:true,force:true});}
