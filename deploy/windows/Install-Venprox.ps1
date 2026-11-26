param([string]$PackageDirectory=(Split-Path $PSScriptRoot -Parent),[switch]$NoShortcut)
$ErrorActionPreference='Stop'
$packageRoot=(Resolve-Path -LiteralPath $PackageDirectory).Path
$manifest=Get-Content -LiteralPath (Join-Path $packageRoot 'distribution.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($manifest.format -ne 1 -or $manifest.build_id -notmatch '^[a-zA-Z0-9.-]+$'){throw 'Invalid distribution'}
foreach($file in $manifest.files){
 $candidate=[IO.Path]::GetFullPath((Join-Path $packageRoot $file.path))
 if(-not $candidate.StartsWith($packageRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid path'}
 $stream=[IO.File]::OpenRead($candidate);$hasher=[Security.Cryptography.SHA256]::Create()
 try{$sum=[BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','')}finally{$hasher.Dispose();$stream.Dispose()}
 if($sum -ne $file.sha256){throw 'Package checksum mismatch'}
}
$installBase=Join-Path $env:LOCALAPPDATA 'Programs\Venprox'
$installPath=Join-Path $installBase $manifest.build_id
if(Test-Path -LiteralPath $installPath){throw 'This build is already installed; choose the existing version or a new build'}
New-Item -ItemType Directory -Path $installPath | Out-Null
Get-ChildItem -LiteralPath $packageRoot -Force | Copy-Item -Destination $installPath -Recurse -Force
$configPath=Join-Path $env:LOCALAPPDATA 'Venprox\config'
New-Item -ItemType Directory -Path $configPath -Force | Out-Null
# No environment, database, credential or administrator is created/copied by this installer.
if(-not $NoShortcut){
 $shell=New-Object -ComObject WScript.Shell
 $shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Venprox.lnk'))
 $shortcut.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe'
 $shortcut.Arguments='"'+(Join-Path $installPath 'Iniciar-Venprox.vbs')+'"'
 $shortcut.WorkingDirectory=$installPath
 $shortcut.Save()
}
Write-Output 'Installed. Existing financial data and private configuration were preserved. Configure local.env separately before first use.'
