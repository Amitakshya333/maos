param([string]$TaskRoot,[string]$AppRoot,[string]$EvidenceRoot)
$ErrorActionPreference='Continue'
$TaskRoot=[IO.Path]::GetFullPath($TaskRoot); $AppRoot=[IO.Path]::GetFullPath($AppRoot); $EvidenceRoot=[IO.Path]::GetFullPath($EvidenceRoot)
$profile=Join-Path $TaskRoot 'cli isolated profile with spaces'; New-Item -ItemType Directory -Path $profile -Force | Out-Null
$removed=@(Get-ChildItem Env: | Where-Object {$_.Name -match '(?i)(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)' -or $_.Name -match '^GIT_'})
foreach($v in $removed){Remove-Item -LiteralPath ('Env:'+ $v.Name) -ErrorAction SilentlyContinue}
$env:USERPROFILE=$profile; $env:HOME=$profile; $env:APPDATA=Join-Path $profile 'AppData/Roaming'; $env:LOCALAPPDATA=Join-Path $profile 'AppData/Local'; $env:TEMP=Join-Path $TaskRoot 'cli temp with spaces'; $env:TMP=$env:TEMP; New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA,$env:TEMP -Force | Out-Null
$gitConfig=Join-Path $TaskRoot 'cli empty git config'; Set-Content -LiteralPath $gitConfig -Value '' -NoNewline -Encoding ascii; $env:GIT_CONFIG_NOSYSTEM='true'; $env:GIT_CONFIG_GLOBAL=$gitConfig; $env:GIT_CEILING_DIRECTORIES=$TaskRoot
$node=(Get-Command node.exe).Source; $cli=Join-Path $AppRoot 'dist/cli/index.js'; $industrial=Join-Path $AppRoot 'dist/industrial/entrypoint.js'; $script:results=@()
function RunCli([string]$Name,[string[]]$CliArgs,[string]$Cwd){Push-Location $Cwd; try{$out=& $node $CliArgs 2>&1; $code=$LASTEXITCODE; $text=($out | Out-String).TrimEnd(); $script:results+=,[ordered]@{name=$Name;exitCode=$code;output=$text}; return $text} finally{Pop-Location}}
$outer=Join-Path $TaskRoot 'synthetic git parent with spaces'; $child=Join-Path $outer 'selected child project with spaces'; $empty=Join-Path $TaskRoot 'doctor missing-config project with spaces'; New-Item -ItemType Directory -Path $outer,$child,$empty -Force | Out-Null
Push-Location $outer; try{& git init --quiet --initial-branch=pilot *> $null; $gitExit=$LASTEXITCODE} finally{Pop-Location}; if($gitExit -ne 0){throw 'Synthetic parent git init failed.'}
$versionText=RunCli 'maos-version' @($cli,'--version') $TaskRoot
$industrialHelp=RunCli 'industrial-help' @($industrial,'--help') $TaskRoot
$doctorHelp=RunCli 'doctor-help' @($cli,'doctor','--help') $TaskRoot
$childDoctor=RunCli 'doctor-nonrepo-child-under-git-parent' @($cli,'doctor') $child
$parentDoctor=RunCli 'doctor-normal-repository-root' @($cli,'doctor') $outer
$missingDoctor=RunCli 'doctor-missing-config' @($cli,'doctor') $empty
$childText=($script:results | Where-Object name -eq 'doctor-nonrepo-child-under-git-parent').output
$parentText=($script:results | Where-Object name -eq 'doctor-normal-repository-root').output
$childDoesNotLeak=($childText -notmatch [regex]::Escape($outer) -and $childText -notmatch '(?m)^.*\bpilot\b.*$')
$parentHasBranch=($parentText -match '(?m)^.*\bpilot\b.*$')
$report=[ordered]@{timestamp=(Get-Date).ToString('o');installedAppRoot=$AppRoot;nodeVersion=(& $node --version);isolatedWorkingDirectory=$TaskRoot;environmentSecretLikeNamesRemoved=$removed.Count;syntheticParentRepo=$outer;syntheticChild=$child;results=$script:results;childAvoidedAncestorMetadata=$childDoesNotLeak;normalRepoMetadataObserved=$parentHasBranch}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'installed-cli-smoke-final2.json') -Encoding utf8
$report | ConvertTo-Json -Depth 6
if(-not $childDoesNotLeak){throw 'Installed doctor output disclosed metadata from an ancestor repository.'}
