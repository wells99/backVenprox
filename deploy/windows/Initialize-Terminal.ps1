param([Parameter(Mandatory=$true)][string]$Installation,[Parameter(Mandatory=$true)][string]$StoreId,[Parameter(Mandatory=$true)][string]$ApiOrigin)
$ErrorActionPreference='Stop'
if($StoreId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'){throw 'Invalid store UUID'}
$origin=[Uri]$ApiOrigin
if($origin.Scheme -ne 'https' -and -not ($origin.Scheme -eq 'http' -and $origin.IsLoopback)){throw 'HTTPS is required outside loopback'}
if($origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.UserInfo){throw 'Use only the API origin'}
$base=Join-Path $env:LOCALAPPDATA 'Venprox'
$config=Join-Path $base 'config\local.env'
if(Test-Path -LiteralPath $config){throw 'Configuration already exists. Preserve it and use the recovery procedure.'}
$deviceId=[Guid]::NewGuid().ToString()
$data=Join-Path $base ('data\'+$deviceId)
$keys=Join-Path $base 'keys'
New-Item -ItemType Directory -Path (Split-Path $config -Parent),$data,$keys -Force | Out-Null
$database=Join-Path $data 'terminal.db'
$backupKey=Join-Path $keys ('backup-'+$deviceId+'.key')
@("NODE_ENV=production","LOG_LEVEL=info","LOCAL_DATABASE_PATH=$database","STORE_ID=$StoreId","DEVICE_ID=$deviceId","AUTH_API_ORIGIN=$($ApiOrigin.TrimEnd('/'))","LOCAL_SYNC_ENABLED=false","BACKUP_INTERVAL_HOURS=24","RECOVERY_KEY_FILE=$backupKey","LOCAL_BACKUP_DIRECTORY=$(Join-Path $data 'backups')","LOCAL_RECOVERY_DIRECTORY=$(Join-Path $data 'recovery')") | Set-Content -LiteralPath $config -Encoding utf8
$node=Join-Path $Installation 'runtime\node.exe'
$maintenance=Join-Path $Installation 'backend\dist\apps\maintenance\src\main.js'
& $node --use-system-ca "--env-file=$config" $maintenance init-key
if($LASTEXITCODE -ne 0){throw 'Key initialization failed. Preserve files and inspect before retry.'}
& $node --use-system-ca "--env-file=$config" $maintenance provision --new-terminal
if($LASTEXITCODE -ne 0){throw 'Provision failed. Preserve files and inspect before retry.'}
Write-Output 'New terminal initialized. Pair it with a single-use administrator invitation. Login offline and automatic synchronization remain disabled. Keep an independent protected copy of the recovery key and completed backups.'
