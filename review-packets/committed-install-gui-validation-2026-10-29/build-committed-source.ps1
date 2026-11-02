param([Parameter(Mandatory=$true)][string]$TaskRoot,[Parameter(Mandatory=$true)][string]$SourceRoot,[Parameter(Mandatory=$true)][string]$PacketRoot)
$ErrorActionPreference='Stop'
$TaskRoot=[IO.Path]::GetFullPath($TaskRoot);$SourceRoot=[IO.Path]::GetFullPath($SourceRoot);$PacketRoot=[IO.Path]::GetFullPath($PacketRoot)
if(-not $SourceRoot.StartsWith($TaskRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Source checkout is outside isolated task root.'}
if(-not $PacketRoot.StartsWith('C:\maos\review-packets\committed-install-gui-validation-2026-10-29',[StringComparison]::OrdinalIgnoreCase)){throw 'Evidence root is outside the authorized packet.'}
$commit='27dd1711f47e6278a1b84a6089e900dbe79f1459';$expectedDelta='d3b267f3e1032eb26b1e814876d4ab17ccd74df63bee62bab4ab27f6e7180622'
$head=(& git -C $SourceRoot rev-parse HEAD).Trim();if($head -cne $commit){throw "Source checkout is at unexpected commit: $head"}
if(Test-Path -LiteralPath (Join-Path $SourceRoot '.npmrc')){throw 'Project .npmrc exists; refusing to expose it to npm.'}
$node=(Get-Command node.exe -ErrorAction Stop).Source;$npm=(Get-Command npm.cmd -ErrorAction Stop).Source;$git=(Get-Command git.exe -ErrorAction Stop).Source
$sys=$env:SystemRoot;$windir=$env:WINDIR;$arch=$env:PROCESSOR_ARCHITECTURE;$count=$env:NUMBER_OF_PROCESSORS;$nodeDir=Split-Path -Parent $node;$gitDir=Split-Path -Parent $git
$buildHome=Join-Path $TaskRoot 'build home with spaces';$temp=Join-Path $TaskRoot 'build temp with spaces';$cache=Join-Path $TaskRoot 'empty build npm cache';$userConfig=Join-Path $buildHome 'user.npmrc';$globalConfig=Join-Path $buildHome 'global.npmrc';$gitConfig=Join-Path $buildHome 'gitconfig-empty'
foreach($p in @($buildHome,$temp,$cache)){if(Test-Path -LiteralPath $p){throw "Expected fresh isolated path: $p"};New-Item -ItemType Directory -Path $p|Out-Null}
Set-Content -LiteralPath $userConfig -Value '# isolated empty npm user config' -Encoding ascii;Set-Content -LiteralPath $globalConfig -Value '# isolated empty npm global config' -Encoding ascii;Set-Content -LiteralPath $gitConfig -Value '# isolated empty git config' -Encoding ascii
$nodeVersion=(& $node --version).Trim();$npmVersion=(& $npm --version).Trim()
foreach($n in @((Get-ChildItem Env:).Name)){Remove-Item -LiteralPath ('Env:'+$n) -ErrorAction SilentlyContinue}
$env:SystemRoot=$sys;$env:WINDIR=$windir;$env:OS='Windows_NT';$env:COMSPEC=Join-Path $sys 'System32\cmd.exe';$env:PATHEXT='.COM;.EXE;.BAT;.CMD';$env:PROCESSOR_ARCHITECTURE=$arch;$env:NUMBER_OF_PROCESSORS=$count
$env:PATH="$nodeDir;$gitDir;$sys\System32";$env:TEMP=$temp;$env:TMP=$temp;$env:USERPROFILE=$buildHome;$env:HOME=$buildHome;$env:APPDATA=Join-Path $buildHome 'AppData\Roaming';$env:LOCALAPPDATA=Join-Path $buildHome 'AppData\Local'
New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA|Out-Null
$env:NPM_CONFIG_USERCONFIG=$userConfig;$env:NPM_CONFIG_GLOBALCONFIG=$globalConfig;$env:NPM_CONFIG_CACHE=$cache;$env:NPM_CONFIG_UPDATE_NOTIFIER='false';$env:NPM_CONFIG_AUDIT='false';$env:NPM_CONFIG_FUND='false';$env:GIT_CONFIG_GLOBAL=$gitConfig;$env:GIT_CONFIG_NOSYSTEM='1';$env:GIT_OPTIONAL_LOCKS='0'
$removedEnvCount=0
function Invoke-Npm([string[]]$arguments,[string]$name){
  $log=Join-Path $PacketRoot ($name+'.log');$command='npm.cmd '+($arguments -join ' ');$command|Set-Content -LiteralPath (Join-Path $PacketRoot ($name+'.command.txt')) -Encoding utf8
  Push-Location $SourceRoot;try{& $npm @arguments *> $log;$exit=$LASTEXITCODE}finally{Pop-Location}
  "EXIT_CODE=$exit"|Add-Content -LiteralPath $log -Encoding utf8
  if($exit -ne 0){throw "$command failed with exit $exit; see $log"}
  return $exit
}
$envLog=Join-Path $PacketRoot 'build-environment.json'
$ciExit=Invoke-Npm @('ci','--no-audit','--no-fund','--include=dev') 'source-npm-ci'
$buildExit=Invoke-Npm @('run','build') 'source-npm-build'
$typecheckExit=Invoke-Npm @('run','typecheck:gui') 'source-gui-typecheck'
$testExit=Invoke-Npm @('test','--','tests/cli/project-git-context.test.ts','tests/cli/doctor.test.ts','tests/cli/meta-provider-entrypoints.test.ts','tests/industrial/package-runtime-assets.test.ts') 'source-focused-tests'
$artifactRoot=Join-Path $PacketRoot 'candidate-artifacts';if(Test-Path -LiteralPath $artifactRoot){throw 'Candidate artifact directory already exists.'};New-Item -ItemType Directory -Path $artifactRoot|Out-Null
$packCommand='npm.cmd pack --ignore-scripts --pack-destination "'+$artifactRoot+'"';$packCommand|Set-Content -LiteralPath (Join-Path $PacketRoot 'npm-pack.command.txt') -Encoding utf8
Push-Location $SourceRoot;try{$packOutput=& $npm pack --ignore-scripts --pack-destination $artifactRoot 2>&1;$packExit=$LASTEXITCODE}finally{Pop-Location}
$packOutput|Set-Content -LiteralPath (Join-Path $PacketRoot 'npm-pack.log') -Encoding utf8;"EXIT_CODE=$packExit"|Add-Content -LiteralPath (Join-Path $PacketRoot 'npm-pack.log') -Encoding utf8
if($packExit -ne 0){throw "npm pack failed with exit $packExit"}
$archive=Get-ChildItem -LiteralPath $artifactRoot -Filter '*.tgz' -File|Select-Object -First 1;if(-not $archive){throw 'npm pack produced no archive.'}
$commitPatch=Join-Path $PacketRoot 'committed-delta.patch';$expectedPatchHash=(Get-FileHash -LiteralPath $commitPatch -Algorithm SHA256).Hash.ToLowerInvariant();if($expectedPatchHash -cne $expectedDelta){throw "Committed source patch hash mismatch: $expectedPatchHash"}
$bundle=Join-Path $artifactRoot 'maos-industrial-bootstrap-windows-x64-commit-27dd1711-2026-10-29.zip';$bundleScript=Join-Path $SourceRoot 'scripts\New-MaosIndustrialInstallBundle.ps1';$bundleCommand="powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$bundleScript`" -PackageArchive `"$($archive.FullName)`" -SourceRevision $commit -SourceDeltaSha256 $expectedPatchHash -OutputBundle `"$bundle`"";$bundleCommand|Set-Content -LiteralPath (Join-Path $PacketRoot 'bundle-build.command.txt') -Encoding utf8
$bundleOutput=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $bundleScript -PackageArchive $archive.FullName -SourceRevision $commit -SourceDeltaSha256 $expectedPatchHash -OutputBundle $bundle 2>&1;$bundleExit=$LASTEXITCODE;$bundleOutput|Set-Content -LiteralPath (Join-Path $PacketRoot 'bundle-build.log') -Encoding utf8;"EXIT_CODE=$bundleExit"|Add-Content -LiteralPath (Join-Path $PacketRoot 'bundle-build.log') -Encoding utf8;if($bundleExit -ne 0){throw "Bootstrap bundle creation failed with exit $bundleExit"}
$tracked=@(& git -C $SourceRoot diff --name-only);$staged=@(& git -C $SourceRoot diff --cached --name-only);if($tracked.Count -or $staged.Count){throw "Build altered tracked source: tracked=$($tracked.Count), staged=$($staged.Count)"}
$report=[ordered]@{sourceCommit=$commit;committedDeltaSha256=$expectedPatchHash;nodeVersion=$nodeVersion;npmVersion=$npmVersion;ambientEnvironmentVariablesRemovedBeforeNpm=$true;isolatedNpmCache=$cache;npmCiExitCode=$ciExit;buildExitCode=$buildExit;guiTypecheckExitCode=$typecheckExit;focusedTestsExitCode=$testExit;npmPackExitCode=$packExit;bundleBuildExitCode=$bundleExit;packagePath=$archive.FullName;packageBytes=$archive.Length;packageSha256=(Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bundlePath=$bundle;bundleBytes=(Get-Item -LiteralPath $bundle).Length;bundleSha256=(Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant();sourceTrackedChangesAfterBuild=0;sourceIndexChangesAfterBuild=0;sourceCheckoutRootHadNodeModulesBeforeInstall=$false}
$report|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $PacketRoot 'build-results.json') -Encoding utf8;$report|ConvertTo-Json -Depth 5
