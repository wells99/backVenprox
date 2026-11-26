param([ValidateSet('Essential','Full')][string]$Mode='Essential',[switch]$BuildPackage,[switch]$PackagedJourney,[switch]$Load)
$ErrorActionPreference='Stop'
$backend=Split-Path $PSScriptRoot -Parent
$frontend=Join-Path (Split-Path $backend -Parent) 'front-Venprox'
$evidence=Join-Path $backend ('artifacts\homologation-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$checks=[Collections.Generic.List[object]]::new()
function Invoke-Check([string]$Name,[string]$Directory,[string]$Executable,[string[]]$Arguments){
 Push-Location -LiteralPath $Directory
 try{& $Executable @Arguments *> (Join-Path $evidence ($Name+'.log'));$code=$LASTEXITCODE;$checks.Add(@{name=$Name;exit_code=$code});if($code -ne 0){throw "$Name failed. See the private evidence directory."}}
 finally{Pop-Location}
}
try{
 Invoke-Check 'frontend-build' $frontend 'npm.cmd' @('run','build')
 Invoke-Check 'frontend-lint' $frontend 'npm.cmd' @('run','lint')
 Invoke-Check 'backend-types' $backend 'npm.cmd' @('run','typecheck')
 Invoke-Check 'backend-lint' $backend 'npm.cmd' @('run','lint')
 Invoke-Check 'backend-build' $backend 'npm.cmd' @('run','build')
 Invoke-Check 'test-database-setup' $backend 'npm.cmd' @('run','financial:test:setup')
 Invoke-Check 'frontend-tests' $frontend 'npm.cmd' @('test')
 if($Mode -eq 'Full'){Invoke-Check 'backend-regression' $backend 'node' @('--env-file=.env.b03','--import','tsx','--test','tests/*.test.ts','tests/*.test.mjs')}
 else{Invoke-Check 'backend-essential' $backend 'node' @('--env-file=.env.b03','--import','tsx','--test','tests/recovery.test.ts','tests/legacy-import.test.ts','tests/config.test.ts','tests/boundaries.test.mjs')}
 if($BuildPackage){Invoke-Check 'package' $backend 'node' @('scripts/package-desktop-windows.mjs')}
 if($PackagedJourney){
  $package=Get-Content -LiteralPath (Join-Path $backend 'artifacts\desktop-latest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $previous=$env:VENPROX_PACKAGE_DIRECTORY
  try{$env:VENPROX_PACKAGE_DIRECTORY=$package.directory;Invoke-Check 'packaged-journey' $backend 'node' @('--env-file=.env.b03','--import','tsx','--test','tests/frontend-journey.test.ts')}
  finally{if($null -eq $previous){Remove-Item Env:\VENPROX_PACKAGE_DIRECTORY -ErrorAction SilentlyContinue}else{$env:VENPROX_PACKAGE_DIRECTORY=$previous}}
 }
 if($Load){Invoke-Check 'load-10000' $backend 'npm.cmd' @('run','benchmark:b13')}
 Invoke-Check 'privacy' $backend 'node' @('scripts/check-private-files.mjs','--working-tree')
 Invoke-Check 'openapi' $backend 'npm.cmd' @('run','openapi:export')
 $result='automated_checks_passed'
}catch{$result='failed';throw}
finally{
 @{format=1;mode=$Mode;result=$result;created_at=(Get-Date).ToUniversalTime().ToString('o');checks=$checks;pilot_authorized=$false;manual_gates=@('provider_node_https_workers','dedicated_runtime_sql_account','external_backup_and_key_escrow','restore_time_and_responsible','shop_hardware','owner_pilot_acceptance')} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'report.json') -Encoding utf8
 Write-Output "Evidence: $evidence. Automated checks do not authorize the pilot."
}
