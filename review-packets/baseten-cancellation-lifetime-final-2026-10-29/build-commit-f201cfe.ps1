param([Parameter(Mandatory=$true)][string]$SourceRoot,[Parameter(Mandatory=$true)][string]$PacketRoot)
$ErrorActionPreference='Stop'
$SourceRoot=[IO.Path]::GetFullPath($SourceRoot);$PacketRoot=[IO.Path]::GetFullPath($PacketRoot)
$commit='f201cfe38bf3a741b5d8c6b37793cc3c112c43a9';$delta='d3eb82e46a242ff63aae6323c84820a3a1ff000fdd990bf7e23717b103c8b059'
if((& git -C $SourceRoot rev-parse HEAD).Trim() -cne $commit){throw 'Source worktree does not have the expected checkpoint.'}
& git -C $SourceRoot diff --quiet;if($LASTEXITCODE -ne 0){throw 'Source worktree has tracked edits before build.'}
& git -C $SourceRoot diff --cached --quiet;if($LASTEXITCODE -ne 0){throw 'Source worktree index is not empty before build.'}
if(Test-Path (Join-Path $SourceRoot '.npmrc')){throw 'Source project contains .npmrc; refusing ambient registry auth/config.'}
$node=(Get-Command node.exe -ErrorAction Stop).Source;$npm=(Get-Command npm.cmd -ErrorAction Stop).Source;$git=(Get-Command git.exe -ErrorAction Stop).Source;$pwsh=(Get-Command pwsh.exe -ErrorAction Stop).Source
$nodeDir=Split-Path -Parent $node;$gitDir=Split-Path -Parent $git;$npmCli=Join-Path $nodeDir 'node_modules\npm\bin\npm-cli.js';if(!(Test-Path $npmCli)){throw "Pinned npm CLI missing: $npmCli"}
$nodeVersion=(& $node --version).Trim();$npmVersion=(& $npm --version).Trim();$pwshVersion=(& $pwsh -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()').Trim()
$buildRoot=Join-Path $env:TEMP 'maos-f201cfe-build-isolation-20261029';if(Test-Path $buildRoot){throw "Build isolation path already exists: $buildRoot"};New-Item -ItemType Directory -Path $buildRoot|Out-Null
$buildHome=Join-Path $buildRoot 'user-profile';$temp=Join-Path $buildRoot 'temp';$cache=Join-Path $buildRoot 'npm-cache';foreach($dir in @($buildHome,$temp,$cache)){New-Item -ItemType Directory -Path $dir|Out-Null}
$userConfig=Join-Path $buildHome 'user.npmrc';$globalConfig=Join-Path $buildHome 'global.npmrc';$gitConfig=Join-Path $buildHome 'empty.gitconfig';Set-Content $userConfig '# isolated empty npm config' -Encoding ascii;Set-Content $globalConfig '# isolated empty npm config' -Encoding ascii;Set-Content $gitConfig '# isolated empty git config' -Encoding ascii
$artifacts=Join-Path $PacketRoot 'candidate-artifacts-f201cfe';if(Test-Path $artifacts){throw 'Candidate artifact folder already exists; refusing overwrite.'};New-Item -ItemType Directory -Path $artifacts|Out-Null
$originalEnv=@{};Get-ChildItem Env:|ForEach-Object {$originalEnv[$_.Name]=$_.Value}
function Quote([string]$value){return '"'+$value.Replace('"','\"')+'"'}
function Run-Npm([string[]]$npmArgs,[string]$name){
  $stdout=Join-Path $PacketRoot ($name+'.stdout.log');$stderr=Join-Path $PacketRoot ($name+'.stderr.log');$combined=Join-Path $PacketRoot ($name+'.log');
  $argsLine=((@($npmCli)+$npmArgs|ForEach-Object {Quote $_}) -join ' ');$cmd='node.exe npm-cli.js '+($npmArgs -join ' ')
  $cmd|Set-Content -LiteralPath (Join-Path $PacketRoot ($name+'.command.txt')) -Encoding utf8
  $proc=Start-Process -FilePath $node -ArgumentList $argsLine -WorkingDirectory $SourceRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $exit=$proc.ExitCode;$out=if(Test-Path $stdout){Get-Content $stdout -Raw}else{''};$err=if(Test-Path $stderr){Get-Content $stderr -Raw}else{''};$logText="COMMAND: $cmd`nEXIT_CODE=$exit`n[stdout]`n$out`n[stderr]`n$err";$logText|Set-Content -LiteralPath $combined -Encoding utf8
  if($exit -ne 0){throw "$cmd failed with exit $exit; see $combined"};return $exit
}
try {
  foreach($name in @((Get-ChildItem Env:).Name)){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
  $env:SystemRoot=$originalEnv['SystemRoot'];$env:WINDIR=$originalEnv['WINDIR'];$env:OS='Windows_NT';$env:COMSPEC=Join-Path $env:SystemRoot 'System32\cmd.exe';$env:PATHEXT='.COM;.EXE;.BAT;.CMD';$env:PROCESSOR_ARCHITECTURE=$originalEnv['PROCESSOR_ARCHITECTURE'];$env:NUMBER_OF_PROCESSORS=$originalEnv['NUMBER_OF_PROCESSORS'];$env:PATH="$nodeDir;$gitDir;$env:SystemRoot\System32";$env:TEMP=$temp;$env:TMP=$temp;$env:USERPROFILE=$buildHome;$env:HOME=$buildHome;$env:APPDATA=Join-Path $buildHome 'AppData\Roaming';$env:LOCALAPPDATA=Join-Path $buildHome 'AppData\Local';New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA|Out-Null
  $env:NPM_CONFIG_USERCONFIG=$userConfig;$env:NPM_CONFIG_GLOBALCONFIG=$globalConfig;$env:NPM_CONFIG_CACHE=$cache;$env:NPM_CONFIG_AUDIT='false';$env:NPM_CONFIG_FUND='false';$env:GIT_CONFIG_GLOBAL=$gitConfig;$env:GIT_CONFIG_NOSYSTEM='1';$env:GIT_OPTIONAL_LOCKS='0';$env:HUSKY='0'
  $ci=Run-Npm @('ci','--no-audit','--no-fund','--include=dev') 'build-npm-ci'
  $build=Run-Npm @('run','build') 'build-npm-build'
  $pack=Run-Npm @('pack','--ignore-scripts','--pack-destination',$artifacts) 'build-npm-pack'
} finally {
  foreach($name in @((Get-ChildItem Env:).Name)){Remove-Item -LiteralPath ('Env:'+$name) -ErrorAction SilentlyContinue}
  foreach($name in $originalEnv.Keys){Set-Item -Path ('Env:'+ $name) -Value $originalEnv[$name]}
}
$archive=Get-ChildItem -LiteralPath $artifacts -Filter '*.tgz' -File|Select-Object -First 1;if(!$archive){throw 'npm pack did not create tarball.'}
$bundle=Join-Path $artifacts 'maos-industrial-bootstrap-windows-x64-commit-f201cfe-2026-10-29.zip'
$bundleArgs=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $SourceRoot 'scripts\New-MaosIndustrialInstallBundle.ps1'),'-PackageArchive',$archive.FullName,'-SourceRevision',$commit,'-SourceDeltaSha256',$delta,'-OutputBundle',$bundle)
$line=($bundleArgs|ForEach-Object {Quote $_}) -join ' ';$line|Set-Content -LiteralPath (Join-Path $PacketRoot 'build-bundle.command.txt') -Encoding utf8
$bundleProc=Start-Process -FilePath $pwsh -ArgumentList $line -WorkingDirectory $SourceRoot -NoNewWindow -Wait -PassThru -RedirectStandardOutput (Join-Path $PacketRoot 'build-bundle.stdout.log') -RedirectStandardError (Join-Path $PacketRoot 'build-bundle.stderr.log');$bundleExit=$bundleProc.ExitCode
if($bundleExit -ne 0){throw "Bootstrap bundle builder failed with exit $bundleExit."}
& git -C $SourceRoot diff --quiet;if($LASTEXITCODE -ne 0){throw 'Build changed tracked source.'};& git -C $SourceRoot diff --cached --quiet;if($LASTEXITCODE -ne 0){throw 'Build staged source changes.'}
$result=[ordered]@{sourceCommit=$commit;sourceDeltaSha256=$delta;nodeVersion=$nodeVersion;npmVersion=$npmVersion;buildPowerShellVersion=$pwshVersion;hooksDisabledForBuildInstallOnly=$true;noAmbientNpmConfigOrCredentials=$true;isolatedNpmCache=$cache;npmCiExitCode=$ci;buildExitCode=$build;packExitCode=$pack;bundleBuildExitCode=$bundleExit;packagePath=$archive.FullName;packageBytes=$archive.Length;packageSha256=(Get-FileHash $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bundlePath=$bundle;bundleBytes=(Get-Item $bundle).Length;bundleSha256=(Get-FileHash $bundle -Algorithm SHA256).Hash.ToLowerInvariant();sourceTrackedChangesAfterBuild=0;sourceIndexChangesAfterBuild=0}
$result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $PacketRoot 'build-results-f201cfe.json') -Encoding utf8;$result|ConvertTo-Json -Depth 5