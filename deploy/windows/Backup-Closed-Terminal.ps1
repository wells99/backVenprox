param([Parameter(Mandatory=$true)][string]$Installation,[Parameter(Mandatory=$true)][string]$EnvironmentFile)
$ErrorActionPreference='Stop'
$node=Join-Path $Installation 'runtime\node.exe'
$entry=Join-Path $Installation 'backend\dist\apps\maintenance\src\main.js'
# Run only with the terminal closed. The live service generates its own daily copy when configured.
# Exclusive ownership is never bypassed; a busy database is a failed backup, never an empty one.
& $node --use-system-ca "--env-file=$EnvironmentFile" $entry backup
exit $LASTEXITCODE
