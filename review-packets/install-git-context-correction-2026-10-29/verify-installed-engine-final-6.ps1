param([Parameter(Mandatory=$true)][string]$TaskRoot,[Parameter(Mandatory=$true)][string]$InstallRoot,[Parameter(Mandatory=$true)][string]$EngineBinary,[Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop'
$TaskRoot=[System.IO.Path]::GetFullPath($TaskRoot)
$InstallRoot=[System.IO.Path]::GetFullPath($InstallRoot)
$EngineBinary=[System.IO.Path]::GetFullPath($EngineBinary)
$rootPrefix=$TaskRoot.TrimEnd('\')+'\'
foreach($path in @($InstallRoot,$EngineBinary)){if(-not $path.StartsWith($rootPrefix,[System.StringComparison]::OrdinalIgnoreCase)){throw 'Install or engine path is outside the isolated task root.'}}
if(-not $EvidenceRoot.StartsWith('C:\maos\review-packets\install-git-context-correction-2026-10-29',[System.StringComparison]::OrdinalIgnoreCase)){throw 'Evidence path is outside the authorized packet.'}
$parent=Join-Path $TaskRoot 'synthetic git ancestor with spaces'
$selected=Join-Path $parent 'selected project with spaces'
$redirect=Join-Path $TaskRoot 'redirected synthetic repository with spaces'
$projectEngine=Join-Path $selected 'rust\target\release\maos-engine.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $projectEngine) -Force | Out-Null
Copy-Item -LiteralPath $EngineBinary -Destination $projectEngine
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$gitPath=(Get-Command git.exe -ErrorAction Stop).Source
$systemRoot=$env:SystemRoot
$homePath=Join-Path $TaskRoot 'fresh validation home final6 with spaces'
$tempPath=Join-Path $TaskRoot 'fresh validation temp final6 with spaces'
$nodeDir=Split-Path -Parent $nodePath
$gitDir=Split-Path -Parent $gitPath
foreach($name in @((Get-ChildItem Env:).Name)){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
$env:SystemRoot=$systemRoot
$env:WINDIR=$systemRoot
$env:OS='Windows_NT'
$env:COMSPEC=Join-Path $systemRoot 'System32\cmd.exe'
$env:PATHEXT='.COM;.EXE;.BAT;.CMD'
$env:PATH="$nodeDir;$gitDir;$($systemRoot)\System32"
$env:TEMP=$tempPath
$env:TMP=$tempPath
$env:USERPROFILE=$homePath
$env:HOME=$homePath
$env:APPDATA=Join-Path $homePath 'AppData\Roaming'
$env:LOCALAPPDATA=Join-Path $homePath 'AppData\Local'
$env:GIT_DIR=Join-Path $redirect '.git'
$env:GIT_WORK_TREE=$redirect
$env:GIT_INDEX_FILE=Join-Path $redirect '.git\index'
$cli=Join-Path $InstallRoot 'app\dist\cli\index.js'
$log=Join-Path $EvidenceRoot 'installed-doctor-external-engine-final-6.log'
Push-Location $selected
try{$output=& $nodePath $cli doctor 2>&1;$exit=$LASTEXITCODE}finally{Pop-Location}
$output | Set-Content -LiteralPath $log -Encoding utf8
$text=$output -join [Environment]::NewLine
if($exit -ne 0 -or $text -notmatch 'Rust engine\s+\[required\].*0\.1\.0, protocol 1\.0' -or $text -notmatch 'No project repository' -or $text -match 'Branch: parent-sentinel-branch|Branch: redirect-sentinel-branch'){throw "Installed doctor did not accept the external engine/protocol or exposed ancestor Git: exit=$exit"}
$result=[ordered]@{installedDoctorExitCode=$exit;externalEnginePath=$projectEngine;externalEngineSha256=(Get-FileHash -LiteralPath $projectEngine -Algorithm SHA256).Hash.ToLowerInvariant();rustEngineIdentityAndProtocolAccepted=($text -match '0\.1\.0, protocol 1\.0');ancestorRepositoryHidden=($text -match 'No project repository');hostileGitEnvironmentIgnored=($text -notmatch 'Branch: parent-sentinel-branch|Branch: redirect-sentinel-branch');inferenceCalled=$false}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-external-engine-results-final-6.json') -Encoding utf8
$result | ConvertTo-Json -Depth 4
