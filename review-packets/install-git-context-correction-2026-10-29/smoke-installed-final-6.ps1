param(
  [Parameter(Mandatory = $true)][string]$TaskRoot,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot
)
$ErrorActionPreference='Stop'
$TaskRoot=[System.IO.Path]::GetFullPath($TaskRoot)
$InstallRoot=[System.IO.Path]::GetFullPath($InstallRoot)
$rootPrefix=$TaskRoot.TrimEnd('\')+'\'
if(-not $InstallRoot.StartsWith($rootPrefix,[System.StringComparison]::OrdinalIgnoreCase)){throw 'Installed root is outside the isolated task root.'}
if(-not $EvidenceRoot.StartsWith('C:\maos\review-packets\install-git-context-correction-2026-10-29',[System.StringComparison]::OrdinalIgnoreCase)){throw 'Evidence output is outside the authorized packet.'}
$appRoot=Join-Path $InstallRoot 'app'
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$gitPath=(Get-Command git.exe -ErrorAction Stop).Source
$nodeDir=Split-Path -Parent $nodePath
$gitDir=Split-Path -Parent $gitPath
$systemRoot=$env:SystemRoot
$homePath=Join-Path $TaskRoot 'fresh validation home final6 with spaces'
$tempPath=Join-Path $TaskRoot 'fresh validation temp final6 with spaces'
$appData=Join-Path $homePath 'AppData\Roaming'
$localAppData=Join-Path $homePath 'AppData\Local'
foreach($name in @((Get-ChildItem Env:).Name)){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
$env:SystemRoot=$systemRoot
$env:WINDIR=$systemRoot
$env:OS='Windows_NT'
$env:COMSPEC=Join-Path $systemRoot 'System32\cmd.exe'
$env:PATHEXT='.COM;.EXE;.BAT;.CMD'
$env:PROCESSOR_ARCHITECTURE='AMD64'
$env:PATH="$nodeDir;$gitDir;$($systemRoot)\System32"
$env:TEMP=$tempPath
$env:TMP=$tempPath
$env:USERPROFILE=$homePath
$env:HOME=$homePath
$env:APPDATA=$appData
$env:LOCALAPPDATA=$localAppData
$cli=Join-Path $appRoot 'dist\cli\index.js'
$industrial=Join-Path $appRoot 'dist\industrial\entrypoint.js'
$cliOut=& $nodePath $cli --version 2>&1
$cliExit=$LASTEXITCODE
$cliOut | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-cli-version-final-6.log') -Encoding utf8
if($cliExit -ne 0){throw "Installed generic CLI failed: $cliExit"}
$industrialOut=& $nodePath $industrial --help 2>&1
$industrialExit=$LASTEXITCODE
$industrialOut | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-industrial-help-final-6.log') -Encoding utf8
if($industrialExit -ne 0){throw "Installed Industrial CLI help failed: $industrialExit"}
$missingProject=Join-Path $TaskRoot 'doctor missing-config project with spaces'
$missingOut=$null
Push-Location $missingProject
try{$missingOut=& $nodePath $cli doctor 2>&1;$missingExit=$LASTEXITCODE}finally{Pop-Location}
$missingOut | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-doctor-missing-config-final-6.log') -Encoding utf8
if($missingExit -ne 1 -or (($missingOut -join [Environment]::NewLine) -notmatch 'maos init')){throw "Missing-config doctor smoke failed: $missingExit"}
$parent=Join-Path $TaskRoot 'synthetic git ancestor with spaces'
$selected=Join-Path $parent 'selected project with spaces'
$redirect=Join-Path $TaskRoot 'redirected synthetic repository with spaces'
$maosRoot=Join-Path $selected '.maos'
$configPath=Join-Path $maosRoot 'maos.config.json'
$utf8NoBom=[System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($configPath,'{"projectName":"install-smoke","agents":[],"providers":{},"profile":{"id":"industrial"}}',$utf8NoBom)
$env:GIT_DIR=Join-Path $redirect '.git'
$env:GIT_WORK_TREE=$redirect
$env:GIT_INDEX_FILE=Join-Path $redirect '.git\index'
$projectOut=$null
Push-Location $selected
try{$projectOut=& $nodePath $cli doctor 2>&1;$projectExit=$LASTEXITCODE}finally{Pop-Location}
$projectOut | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-doctor-nested-project-final-6.log') -Encoding utf8
$projectText=$projectOut -join [Environment]::NewLine
if($projectExit -ne 1 -or $projectText -notmatch 'Rust engine' -or $projectText -notmatch 'maos-engine\.exe' -or $projectText -notmatch 'No project repository' -or $projectText -match 'Branch: parent-sentinel-branch|Branch: redirect-sentinel-branch' -or $projectText -notmatch 'doctor never sends inference requests'){throw "Nested-project doctor smoke failed: $projectExit"}
$electronExe=Join-Path $appRoot 'desktop\node_modules\electron\dist\electron.exe'
$electronMarker=Join-Path (Split-Path -Parent $electronExe) 'version'
if(-not (Test-Path -LiteralPath $electronExe -PathType Leaf) -or -not (Test-Path -LiteralPath $electronMarker -PathType Leaf)){throw 'Electron runtime files are absent.'}
$electronVersion=(Get-Content -LiteralPath $electronMarker -Raw).Trim()
$runtimeLogRoot=Join-Path $tempPath ('maos-electron-version-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtimeLogRoot | Out-Null
try{
  $runtimeProcess=Start-Process -FilePath $electronExe -ArgumentList '--version' -WorkingDirectory $appRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $runtimeLogRoot 'stdout.log') -RedirectStandardError (Join-Path $runtimeLogRoot 'stderr.log')
  $electronExit=$runtimeProcess.ExitCode
  $electronOutput=(Get-Content -LiteralPath (Join-Path $runtimeLogRoot 'stdout.log') -Raw) + (Get-Content -LiteralPath (Join-Path $runtimeLogRoot 'stderr.log') -Raw)
}finally{Remove-Item -LiteralPath $runtimeLogRoot -Recurse -Force}
$electronOutput | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-electron-version-final-6.log') -Encoding utf8
if($electronExit -ne 0 -or $electronOutput -notmatch [regex]::Escape($electronVersion)){throw "Installed Electron version check failed: exit=$electronExit"}
$npmCache=Join-Path $TaskRoot 'empty npm cache final6 with spaces'
$electronCache=Join-Path $TaskRoot 'empty Electron cache final6 with spaces'
$cacheCounts=[ordered]@{npmFiles=(Get-ChildItem -LiteralPath $npmCache -Recurse -Force | Measure-Object).Count;electronFiles=(Get-ChildItem -LiteralPath $electronCache -Recurse -Force | Measure-Object).Count}
$result=[ordered]@{sourceRevision='189e786ff0431b02b95ca618bb4791a5ad7b0215';sourceDeltaSha256='ea2ffa2c90cb571add1cab5d3b9f5b26ec2d44b30b0cadbfd621a852304903bb';installRoot=$InstallRoot;installPathContainsSpaces=($InstallRoot -match ' ');installerSucceeded=$true;genericCliVersionExitCode=$cliExit;industrialCliHelpExitCode=$industrialExit;missingConfigDoctorExitCode=$missingExit;missingConfigActionable=($missingOut -join [Environment]::NewLine -match 'maos init');nestedProjectDoctorExitCode=$projectExit;nestedProjectNoAncestorGit=$projectText.Contains('No project repository');wrongGitEnvironmentIgnored=($projectText -notmatch 'Branch: parent-sentinel-branch|Branch: redirect-sentinel-branch');requiredExternalRustEngineReported=($projectText -match 'maos-engine\.exe');doctorNoInference=($projectText -match 'doctor never sends inference requests');electronExe=$electronExe;electronVersion=$electronVersion;electronVersionCommandExitCode=$electronExit;isolatedCacheFileCounts=$cacheCounts;guiWorkflowLaunched=$false}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'clean-install-smoke-results-final-6.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5
