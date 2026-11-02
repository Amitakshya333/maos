param(
  [Parameter(Mandatory = $true)][string]$TaskRoot,
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$EvidenceRoot
)
$ErrorActionPreference='Stop'
$TaskRoot=[System.IO.Path]::GetFullPath($TaskRoot)
$BundleRoot=[System.IO.Path]::GetFullPath($BundleRoot)
$InstallRoot=[System.IO.Path]::GetFullPath($InstallRoot)
$EvidenceRoot=[System.IO.Path]::GetFullPath($EvidenceRoot)
$rootPrefix=$TaskRoot.TrimEnd('\')+'\'
foreach ($item in @($BundleRoot,$InstallRoot)) {
  if (-not $item.StartsWith($rootPrefix,[System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Validation path is outside the isolated task root: $item"
  }
}
if (Test-Path -LiteralPath $InstallRoot) { throw "Fresh install destination already exists: $InstallRoot" }
$nodePath=(Get-Command node.exe -ErrorAction Stop).Source
$npmPath=(Get-Command npm.cmd -ErrorAction Stop).Source
$tarPath=(Get-Command tar.exe -ErrorAction Stop).Source
$gitPath=(Get-Command git.exe -ErrorAction Stop).Source
$systemRoot=$env:SystemRoot
$comspec=Join-Path $systemRoot 'System32\cmd.exe'
$processorArchitecture=$env:PROCESSOR_ARCHITECTURE
$numberOfProcessors=$env:NUMBER_OF_PROCESSORS
$nodeDir=Split-Path -Parent $nodePath
$gitDir=Split-Path -Parent $gitPath
$validationHome=Join-Path $TaskRoot 'fresh validation home final3 with spaces'
$validationTemp=Join-Path $TaskRoot 'fresh validation temp final3 with spaces'
$appData=Join-Path $validationHome 'AppData\Roaming'
$localAppData=Join-Path $validationHome 'AppData\Local'
$npmCache=Join-Path $TaskRoot 'empty npm cache final3 with spaces'
$electronCache=Join-Path $TaskRoot 'empty Electron cache final3 with spaces'
$userConfig=Join-Path $validationHome 'user-npmrc-empty'
$globalConfig=Join-Path $validationHome 'global-npmrc-empty'
foreach ($newPath in @($validationHome,$validationTemp,$npmCache,$electronCache)) {
  if (Test-Path -LiteralPath $newPath) { throw "Expected a fresh isolated path: $newPath" }
  New-Item -ItemType Directory -Path $newPath | Out-Null
}
New-Item -ItemType Directory -Path $appData,$localAppData | Out-Null
Set-Content -LiteralPath $userConfig -Value '# isolated empty user config' -Encoding ascii
Set-Content -LiteralPath $globalConfig -Value '# isolated empty global config' -Encoding ascii
$npmInitialCount=(Get-ChildItem -LiteralPath $npmCache -Force | Measure-Object).Count
$electronInitialCount=(Get-ChildItem -LiteralPath $electronCache -Force | Measure-Object).Count
if ($npmInitialCount -ne 0 -or $electronInitialCount -ne 0) { throw 'Isolated caches were not empty before install.' }
$nodeVersion=(& $nodePath --version).Trim()
$npmVersion=(& $npmPath --version).Trim()
$tarVersion=(& $tarPath --version | Select-Object -First 1).Trim()
$gitVersion=(& $gitPath --version).Trim()
$removedEnvironmentCount=(Get-ChildItem Env:).Count
foreach ($name in @((Get-ChildItem Env:).Name)) { Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue }
$env:SystemRoot=$systemRoot
$env:WINDIR=$systemRoot
$env:OS='Windows_NT'
$env:COMSPEC=$comspec
$env:PATHEXT='.COM;.EXE;.BAT;.CMD'
$env:PROCESSOR_ARCHITECTURE=$processorArchitecture
$env:NUMBER_OF_PROCESSORS=$numberOfProcessors
$env:PATH="$nodeDir;$gitDir;$($systemRoot)\System32"
$env:TEMP=$validationTemp
$env:TMP=$validationTemp
$env:USERPROFILE=$validationHome
$env:HOME=$validationHome
$env:APPDATA=$appData
$env:LOCALAPPDATA=$localAppData
$env:NPM_CONFIG_USERCONFIG=$userConfig
$env:NPM_CONFIG_GLOBALCONFIG=$globalConfig
$env:NPM_CONFIG_CACHE=$npmCache
$env:NPM_CONFIG_UPDATE_NOTIFIER='false'
$env:electron_config_cache=$electronCache
$env:ELECTRON_CACHE=$electronCache
if (-not $EvidenceRoot.StartsWith('C:\maos\review-packets\install-git-context-correction-2026-10-29',[System.StringComparison]::OrdinalIgnoreCase)) { throw "Evidence output is outside the authorized packet directory: $EvidenceRoot" }
$installer=Join-Path $BundleRoot 'Install-MaosIndustrial.ps1'
$longBase=Join-Path $TaskRoot 'long path preflight with spaces '
$electronRelative='\app\desktop\node_modules\electron\dist\electron.exe'
$targetLength=240-$electronRelative.Length
$longInstallRoot=$longBase+('x'*($targetLength-$longBase.Length))
$longProjectedPath=Join-Path $longInstallRoot $electronRelative.TrimStart('\')
$preflightLines=@()
$preflightExit=0
try {
  $preflightLines=@(& $installer -BundleRoot $BundleRoot -InstallRoot $longInstallRoot 2>&1)
} catch {
  $preflightLines+=($_.Exception.Message)
  $preflightExit=1
}
$preflightText=$preflightLines -join [Environment]::NewLine
$preflightLog=Join-Path $EvidenceRoot 'long-path-preflight-final-3.log'
$preflightText | Set-Content -LiteralPath $preflightLog -Encoding utf8
$probeDirectoryExists=[System.IO.Directory]::Exists($longInstallRoot)
if ($preflightExit -eq 0 -or $probeDirectoryExists -or
    $preflightText -notmatch 'limit is 239' -or
    $preflightText -notmatch 'Choose a shorter destination' -or
    $preflightText -notmatch 'No install files were written') {
  throw "Long-path refusal assertion failed. Exit=$preflightExit ProjectedPathLength=$($longProjectedPath.Length) DirectoryExists=$probeDirectoryExists Output=$preflightText"
}
$installLog=Join-Path $EvidenceRoot 'clean-install-final-3.log'
$installExit=0
try {
  & $installer -BundleRoot $BundleRoot -InstallRoot $InstallRoot *> $installLog
} catch {
  $_ | Out-String | Add-Content -LiteralPath $installLog -Encoding utf8
  $installExit=1
}
if ($installExit -ne 0) {
  throw "Clean install failed; see $installLog"
}
$appRoot=Join-Path $InstallRoot 'app'
$electronExe=Join-Path $appRoot 'desktop\node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe -PathType Leaf)) { throw 'Installed Electron executable is missing.' }
$electronMarker=Join-Path (Split-Path -Parent $electronExe) 'version'
if (-not (Test-Path -LiteralPath $electronMarker -PathType Leaf)) { throw 'Installed Electron version marker is missing.' }
$electronVersion=(Get-Content -LiteralPath $electronMarker -Raw).Trim()
$cliVersionLog=Join-Path $EvidenceRoot 'installed-cli-version-final-3.log'
$cliVersion=& $nodePath (Join-Path $appRoot 'dist\cli\index.js') --version 2>&1
$cliVersionExit=$LASTEXITCODE
$cliVersion | Set-Content -LiteralPath $cliVersionLog -Encoding utf8
if ($cliVersionExit -ne 0) { throw "Installed generic CLI version check failed with exit $cliVersionExit." }
$industrialHelpLog=Join-Path $EvidenceRoot 'installed-industrial-help-final-3.log'
$industrialHelp=& $nodePath (Join-Path $appRoot 'dist\industrial\entrypoint.js') --help 2>&1
$industrialHelpExit=$LASTEXITCODE
$industrialHelp | Set-Content -LiteralPath $industrialHelpLog -Encoding utf8
if ($industrialHelpExit -ne 0) { throw "Installed Industrial CLI help failed with exit $industrialHelpExit." }
$missingProject=Join-Path $TaskRoot 'doctor missing-config project with spaces'
New-Item -ItemType Directory -Path $missingProject | Out-Null
$missingDoctorLog=Join-Path $EvidenceRoot 'installed-doctor-missing-config-final-3.log'
Push-Location $missingProject
try {
  $missingDoctor=& $nodePath (Join-Path $appRoot 'dist\cli\index.js') doctor 2>&1
  $missingDoctorExit=$LASTEXITCODE
} finally { Pop-Location }
$missingDoctor | Set-Content -LiteralPath $missingDoctorLog -Encoding utf8
if ($missingDoctorExit -ne 1 -or (($missingDoctor -join [Environment]::NewLine) -notmatch 'maos init')) {
  throw "Missing-config doctor result was not actionable/nonzero: exit=$missingDoctorExit"
}
$syntheticParent=Join-Path $TaskRoot 'synthetic git ancestor with spaces'
$selectedProject=Join-Path $syntheticParent 'selected project with spaces'
$redirectRepo=Join-Path $TaskRoot 'redirected synthetic repository with spaces'
New-Item -ItemType Directory -Path $selectedProject,$redirectRepo | Out-Null
& $gitPath -C $syntheticParent init --initial-branch=parent-sentinel-branch 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize synthetic ancestor repository.' }
& $gitPath -C $redirectRepo init --initial-branch=redirect-sentinel-branch 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize synthetic redirect repository.' }
$maosRoot=Join-Path $selectedProject '.maos'
New-Item -ItemType Directory -Path $maosRoot | Out-Null
'{"projectName":"install-smoke","agents":[],"providers":{},"profile":{"id":"industrial"}}' | Set-Content -LiteralPath (Join-Path $maosRoot 'maos.config.json') -Encoding utf8
$env:GIT_DIR=Join-Path $redirectRepo '.git'
$env:GIT_WORK_TREE=$redirectRepo
$env:GIT_INDEX_FILE=Join-Path $redirectRepo '.git\index'
$doctorProjectLog=Join-Path $EvidenceRoot 'installed-doctor-nested-project-final-3.log'
Push-Location $selectedProject
try {
  $projectDoctor=& $nodePath (Join-Path $appRoot 'dist\cli\index.js') doctor 2>&1
  $projectDoctorExit=$LASTEXITCODE
} finally { Pop-Location }
$projectDoctor | Set-Content -LiteralPath $doctorProjectLog -Encoding utf8
$projectDoctorText=$projectDoctor -join [Environment]::NewLine
if ($projectDoctorExit -ne 1 -or $projectDoctorText -notmatch 'Rust engine' -or
    $projectDoctorText -notmatch 'maos-engine\.exe' -or
    $projectDoctorText -notmatch 'No project repository' -or
    $projectDoctorText -match 'Branch: parent-sentinel-branch|Branch: redirect-sentinel-branch') {
  throw "Installed doctor project/engine check was unexpected: exit=$projectDoctorExit"
}
$electronLog=Join-Path $EvidenceRoot 'installed-electron-version-final-3.log'
$electronOutput=& $electronExe --version 2>&1
$electronExit=$LASTEXITCODE
$electronOutput | Set-Content -LiteralPath $electronLog -Encoding utf8
if ($electronExit -ne 0 -or ($electronOutput -join [Environment]::NewLine) -notmatch [regex]::Escape($electronVersion)) {
  throw "Installed Electron version command failed: exit=$electronExit marker=$electronVersion output=$electronOutput"
}
$result=[ordered]@{
  sourceRevision='189e786ff0431b02b95ca618bb4791a5ad7b0215'
  bundleRoot=$BundleRoot
  installRoot=$InstallRoot
  destinationHasSpaces=($InstallRoot -match ' ')
  destinationWasFresh=$true
  npmCacheInitiallyEmpty=($npmInitialCount -eq 0)
  electronCacheInitiallyEmpty=($electronInitialCount -eq 0)
  environmentVariablesRemovedBeforeInstall=$removedEnvironmentCount
  isolatedNodeVersion=$nodeVersion
  isolatedNpmVersion=$npmVersion
  isolatedTarVersion=$tarVersion
  isolatedGitVersion=$gitVersion
  longPathProjectedLength=$longProjectedPath.Length
  longPathRefusedBeforeCreate=$true
  genericCliVersionExitCode=$cliVersionExit
  industrialCliHelpExitCode=$industrialHelpExit
  missingConfigDoctorExitCode=$missingDoctorExit
  missingConfigActionable=($missingDoctor -join [Environment]::NewLine -match 'maos init')
  nestedProjectDoctorExitCode=$projectDoctorExit
  nestedProjectReportedNoProjectRepository=($projectDoctorText -match 'No project repository')
  nestedProjectRejectedAncestorAndGitOverrides=($projectDoctorText -notmatch 'Branch: parent-sentinel-branch|Branch: redirect-sentinel-branch')
  missingExternalEngineReported=($projectDoctorText -match 'maos-engine\.exe')
  electronExe=$electronExe
  electronVersion=$electronVersion
  electronVersionCommandExitCode=$electronExit
  finalNpmCacheEntries=(Get-ChildItem -LiteralPath $npmCache -Recurse -Force | Measure-Object).Count
  finalElectronCacheEntries=(Get-ChildItem -LiteralPath $electronCache -Recurse -Force | Measure-Object).Count
}
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'clean-install-results-final-3.json') -Encoding utf8
$result | ConvertTo-Json -Depth 5


