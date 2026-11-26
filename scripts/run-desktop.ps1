param([string]$EnvironmentFile='.env.local.b04')
$ErrorActionPreference='Stop'
$backend=Split-Path $PSScriptRoot -Parent
$config=(Resolve-Path -LiteralPath $EnvironmentFile).Path
$package=Get-Content -LiteralPath (Join-Path $backend 'artifacts\desktop-latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$executable=Join-Path $package.directory 'runtime\electron\Venprox.exe'
if(-not (Test-Path -LiteralPath $executable)){throw 'Build the desktop package first: npm run package:desktop:windows'}
$previous=$env:VENPROX_LOCAL_ENV
try{
 $env:VENPROX_LOCAL_ENV=$config
 Start-Process -FilePath $executable -WorkingDirectory $package.directory -WindowStyle Normal
}finally{if($null -eq $previous){Remove-Item Env:\VENPROX_LOCAL_ENV -ErrorAction SilentlyContinue}else{$env:VENPROX_LOCAL_ENV=$previous}}
