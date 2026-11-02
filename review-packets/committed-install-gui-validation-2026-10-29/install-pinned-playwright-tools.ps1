param([string]$ToolDir,[string]$SourceDesktop,[string]$TaskRoot,[string]$EvidenceRoot)
$ErrorActionPreference='Continue'
New-Item -ItemType Directory -Path $ToolDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceDesktop 'package.json') -Destination (Join-Path $ToolDir 'package.json')
Copy-Item -LiteralPath (Join-Path $SourceDesktop 'package-lock.json') -Destination (Join-Path $ToolDir 'package-lock.json')
$profile=Join-Path $TaskRoot 'playwright isolated profile'; New-Item -ItemType Directory -Path $profile -Force | Out-Null
$env:USERPROFILE=$profile; $env:HOME=$profile; $env:APPDATA=Join-Path $profile 'AppData/Roaming'; $env:LOCALAPPDATA=Join-Path $profile 'AppData/Local'; $env:TEMP=Join-Path $TaskRoot 'playwright temp'; $env:TMP=$env:TEMP
$env:npm_config_cache=Join-Path $TaskRoot 'playwright npm cache empty'; $env:NPM_CONFIG_USERCONFIG=Join-Path $TaskRoot 'playwright empty user npmrc'; $env:NPM_CONFIG_GLOBALCONFIG=Join-Path $TaskRoot 'playwright empty global npmrc'; $env:NPM_CONFIG_REGISTRY='https://registry.npmjs.org/'; $env:NPM_CONFIG_UPDATE_NOTIFIER='false'
New-Item -ItemType Directory -Path $env:APPDATA,$env:LOCALAPPDATA,$env:TEMP,$env:npm_config_cache -Force | Out-Null; Set-Content $env:NPM_CONFIG_USERCONFIG '' -NoNewline; Set-Content $env:NPM_CONFIG_GLOBALCONFIG '' -NoNewline
$removed=@(Get-ChildItem Env: | Where-Object {$_.Name -match '(?i)(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)'})
foreach($v in $removed){Remove-Item -LiteralPath ('Env:'+ $v.Name) -ErrorAction SilentlyContinue}
$npm=(Get-Command npm.cmd).Source; $node=(Get-Command node.exe).Source
$lockHash=(Get-FileHash (Join-Path $ToolDir 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
Push-Location $ToolDir; try{$out=& $npm ci --omit=prod --no-audit --no-fund 2>&1; $code=$LASTEXITCODE; ($out | Out-String) | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'playwright-tool-install.log') -Encoding utf8} finally{Pop-Location}
$installedPlaywright=& $node -p "require(process.argv[1]).version" (Join-Path $ToolDir 'node_modules/playwright/package.json')
$electronPresent=Test-Path -LiteralPath (Join-Path $ToolDir 'node_modules/electron/package.json')
$report=[ordered]@{timestamp=(Get-Date).ToString('o');command='npm ci --omit=prod --no-audit --no-fund';exitCode=$code;npmVersion=(& $npm --version);nodeVersion=(& $node --version);lockSha256=$lockHash;playwrightVersion=$installedPlaywright;electronRuntimeInTools=$electronPresent;secretLikeEnvironmentNamesRemoved=$removed.Count;toolRoot=$ToolDir;npmCacheInitiallyEmpty=$true}
$report | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'playwright-tool-install.json') -Encoding utf8
$report | ConvertTo-Json -Depth 3
if($code -ne 0 -or $installedPlaywright -ne '1.64.1' -or $electronPresent){throw 'Pinned Playwright tool install did not match expected isolated development-only tooling.'}
