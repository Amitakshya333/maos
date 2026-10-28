param(
  [string]$RepoRoot = 'C:\maos',
  [string]$WorkRoot = ''
)
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
  $WorkRoot = Join-Path $env:TEMP ('maos-desktop-release-' + [guid]::NewGuid().ToString('N'))
}
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$WorkRoot = [System.IO.Path]::GetFullPath($WorkRoot)
if (-not $WorkRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "WorkRoot must be inside the system temp directory: $tempRoot"
}
if (Test-Path -LiteralPath $WorkRoot) { throw "WorkRoot already exists; choose a new temporary path: $WorkRoot" }
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
$nodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.(\d+)') { throw 'Node.js is required. Install Node.js 22.12 or newer and add it to PATH.' }
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) { throw "Pinned Electron tooling requires Node.js 22.12 or newer; found $nodeVersion." }

function Invoke-Checked($FilePath, [string[]]$Arguments, [string]$Failure) {
  $output = & $FilePath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$Failure (exit $LASTEXITCODE):`n$($output -join [Environment]::NewLine)" }
  return ,$output
}

function New-IndustrialProject([string]$Destination, [string]$PackageRoot, [string]$EngineSource, [switch]$StageEngine) {
  $demoRoot = Join-Path $Destination 'demo/industrial'
  New-Item -ItemType Directory -Path $demoRoot -Force | Out-Null
  foreach ($name in @('safety_thresholds.json', 'turbine_vibration_log.csv', 'maintenance_report.txt', 'turbine_inspection_scan.pdf')) {
    Copy-Item -LiteralPath (Join-Path $PackageRoot "demo/industrial/$name") -Destination $demoRoot
  }
  $maosRoot = Join-Path $Destination '.maos'
  New-Item -ItemType Directory -Path $maosRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PackageRoot 'profiles/industrial/maos.config.json') -Destination (Join-Path $maosRoot 'maos.config.json')
  if ($StageEngine) {
    $engineTarget = Join-Path $Destination 'rust/target/release'
    New-Item -ItemType Directory -Path $engineTarget -Force | Out-Null
    Copy-Item -LiteralPath $EngineSource -Destination (Join-Path $engineTarget 'maos-engine.exe')
  }
}

Push-Location $RepoRoot
try {
  Invoke-Checked 'npm' @('run', 'build') 'Production build failed' | Out-Null
  $packLines = Invoke-Checked 'npm' @('pack', '--json', '--ignore-scripts', '--pack-destination', $WorkRoot) 'npm pack failed'
  $pack = (ConvertFrom-Json -InputObject ($packLines -join [Environment]::NewLine))[0]
  $tarball = Join-Path $WorkRoot $pack.filename
  $paths = @($pack.files | ForEach-Object { $_.path })
  $fixturePaths = @($paths | Where-Object { $_ -match '^demo/industrial/(safety_thresholds\.json|turbine_vibration_log\.csv|maintenance_report\.txt|turbine_inspection_scan\.pdf)$' })
  $pythonPaths = @($paths | Where-Object { $_ -match '^dist/industrial/python/.*\.py$' })
  $guiPaths = @($paths | Where-Object { $_ -match '^dist/gui/(index\.html|assets/)' })
  $desktopPaths = @($paths | Where-Object { $_ -in @('desktop/main.cjs', 'desktop/preload.cjs', 'desktop/README.md', 'desktop/package.json', 'desktop/package-lock.json') })
  $profilePaths = @($paths | Where-Object { $_ -eq 'profiles/industrial/maos.config.json' })
  $engineInPackage = @($paths | Where-Object { $_ -match '(^|/)maos-engine(\.exe)?$' }).Count -gt 0
  if ($fixturePaths.Count -ne 4) { throw "Expected 4 packaged synthetic fixtures, found $($fixturePaths.Count)." }
  if ($pythonPaths.Count -lt 1) { throw 'Packaged Python assets are missing.' }
  if ($guiPaths.Count -lt 3) { throw "Expected HTML/JS/CSS GUI assets, found $($guiPaths.Count)." }
  if ($desktopPaths.Count -ne 5) { throw "Expected 5 desktop shell/tooling assets, found $($desktopPaths.Count)." }
  if ($profilePaths.Count -ne 1) { throw 'Packaged Industrial profile is missing.' }
  if ($engineInPackage) { throw 'The Rust engine must remain a separately installed prerequisite.' }

  $installRoot = Join-Path $WorkRoot 'clean-install'
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'desktop/package.json') -Destination $installRoot
  Copy-Item -LiteralPath (Join-Path $RepoRoot 'desktop/package-lock.json') -Destination $installRoot
  Invoke-Checked 'npm' @('ci', '--prefix', $installRoot, '--no-audit', '--no-fund', '--include=dev') 'Pinned Electron/Playwright install failed' | Out-Null
  $electronInstaller = Join-Path $installRoot 'node_modules/.bin/install-electron.cmd'
  if (-not (Test-Path -LiteralPath $electronInstaller)) { throw "Pinned Electron binary installer is missing: $electronInstaller" }
  Invoke-Checked $electronInstaller @('--no') 'Pinned Electron runtime download failed' | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $installRoot 'node_modules/electron/dist/electron.exe'))) { throw 'Pinned Electron package installed without the required Windows runtime binary.' }
  Invoke-Checked 'npm' @('install', '--prefix', $installRoot, $tarball, '--no-audit', '--no-fund', '--include=dev') 'Installed-package setup failed' | Out-Null
  $packageRoot = Join-Path $installRoot 'node_modules/maosorch'
  foreach ($path in @('desktop/main.cjs', 'desktop/preload.cjs', 'desktop/README.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $path))) { throw "Installed desktop asset is missing: $path" }
  }

  $engineSource = Join-Path $RepoRoot 'rust/target/release/maos-engine.exe'
  if (-not (Test-Path -LiteralPath $engineSource)) {
    throw "Separate Rust engine prerequisite is missing: $engineSource. Build with: cargo build --release --locked --manifest-path `"$RepoRoot/rust/Cargo.toml`"."
  }
  $engineHash = (Get-FileHash -LiteralPath $engineSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $cli = Join-Path $installRoot 'node_modules/.bin/maos-industrial.cmd'
  if (-not (Test-Path -LiteralPath $cli)) { throw "Dedicated Industrial CLI was not installed: $cli" }

  $cliProject = Join-Path $WorkRoot 'project-cli'
  New-IndustrialProject $cliProject $packageRoot $engineSource
  Push-Location $cliProject
  try {
    $missingOutput = & $cli run --auto-approve --yes --json 2>&1
    $missingExit = $LASTEXITCODE
    $missingText = $missingOutput -join [Environment]::NewLine
    if ($missingExit -eq 0) { throw 'The CLI unexpectedly ran without the separate Rust engine.' }
    $missing = ConvertFrom-Json -InputObject $missingText
    $expectedEnginePath = Join-Path $cliProject 'rust/target/release/maos-engine.exe'
    if ($missing.success -or $missing.message -notlike "*$expectedEnginePath*" -or $missing.message -notlike '*cargo build --release --locked --manifest-path rust/Cargo.toml*' -or $missing.message -notlike '*copy*to the missing path*') {
      throw "Missing-engine error is not actionable:`n$missingText"
    }
    $engineTarget = Join-Path $cliProject 'rust/target/release'
    New-Item -ItemType Directory -Path $engineTarget -Force | Out-Null
    Copy-Item -LiteralPath $engineSource -Destination (Join-Path $engineTarget 'maos-engine.exe')
    $stagedHash = (Get-FileHash -LiteralPath (Join-Path $cliProject 'rust/target/release/maos-engine.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($engineHash -ne $stagedHash) { throw 'The separately staged Rust engine hash does not match the source binary.' }
    $runOutput = & $cli run --auto-approve --yes --json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Installed Industrial CLI run failed:`n$($runOutput -join [Environment]::NewLine)" }
    $cliRun = ConvertFrom-Json -InputObject ($runOutput -join [Environment]::NewLine)
    if (-not $cliRun.success -or $cliRun.overallVerdict -ne 'FAIL' -or -not $cliRun.runId) { throw 'CLI execution did not preserve the expected successful-workflow / FAIL-verdict distinction.' }
    $manifestPath = Join-Path $cliProject ".maos/industrial-runs/$($cliRun.runId).json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.status -ne 'completed' -or $manifest.runId -ne $cliRun.runId) { throw 'CLI run manifest is missing, incomplete, or linked to another run ID.' }
    foreach ($relative in @($cliRun.deliverablePath, $cliRun.auditExportPath)) {
      if (-not $relative -or -not (Test-Path -LiteralPath (Join-Path $cliProject $relative))) { throw "CLI artifact is missing: $relative" }
    }
    $verifyOutput = & $cli verify audit --run-id $cliRun.runId --json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "CLI exact-run verification failed:`n$($verifyOutput -join [Environment]::NewLine)" }
    $cliVerify = ConvertFrom-Json -InputObject ($verifyOutput -join [Environment]::NewLine)
    if (-not $cliVerify.verification.valid -or -not $cliVerify.judgedRun.valid -or $cliVerify.judgedRun.runId -ne $cliRun.runId) { throw 'CLI audit verification did not validate the returned run ID.' }
  }
  finally { Pop-Location }

  $harness = Join-Path $RepoRoot 'tests/release/desktop-browser-rehearsal.cjs'
  $previousNodePath = $env:NODE_PATH
  $env:NODE_PATH = Join-Path $installRoot 'node_modules'
  $rehearsals = @()
  try {
    foreach ($scenario in @('source', 'rules', 'reject')) {
      $number = $rehearsals.Count + 1
      $projectRoot = Join-Path $WorkRoot "project-browser-$number"
      New-IndustrialProject $projectRoot $packageRoot $engineSource -StageEngine
      $evidencePath = Join-Path $WorkRoot "evidence/rehearsal-$number.json"
      $browserOutput = & node $harness --package-root $packageRoot --project-root $projectRoot --scenario $scenario --evidence-path $evidencePath 2>&1
      if ($LASTEXITCODE -ne 0) { throw "Browser rehearsal $number ($scenario) failed:`n$($browserOutput -join [Environment]::NewLine)" }
      $browser = ConvertFrom-Json -InputObject (($browserOutput | Select-Object -Last 1) -join [Environment]::NewLine)
      if ($browser.result -ne 'PASS' -or $browser.workflowStatus -ne 'completed' -or $browser.engineeringVerdict -ne 'FAIL') { throw "Browser rehearsal $number returned an incomplete or misleading result:`n$($browserOutput -join [Environment]::NewLine)" }
      Push-Location $projectRoot
      try {
        $verifyOutput = & $cli verify audit --run-id $browser.finalRunId --json 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Browser-created run exact-ID verification failed:`n$($verifyOutput -join [Environment]::NewLine)" }
        $browserVerify = ConvertFrom-Json -InputObject ($verifyOutput -join [Environment]::NewLine)
        if (-not $browserVerify.verification.valid -or -not $browserVerify.judgedRun.valid -or $browserVerify.judgedRun.runId -ne $browser.finalRunId -or $browserVerify.judgedRun.verdict -ne 'FAIL') {
          throw "Browser-created run did not verify as the same expected FAIL run:`n$($verifyOutput -join [Environment]::NewLine)"
        }
      }
      finally { Pop-Location }
      $browser | Add-Member -NotePropertyName cliVerification -NotePropertyValue @{
        valid = $browserVerify.verification.valid
        judgedRunValid = $browserVerify.judgedRun.valid
        runId = $browserVerify.judgedRun.runId
        verdict = $browserVerify.judgedRun.verdict
      }
      $browser | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $evidencePath -Encoding utf8
      $rehearsals += $browser
    }
  }
  finally { $env:NODE_PATH = $previousNodePath }

  [pscustomobject]@{
    result = 'PASS'
    package = $pack.filename
    tarball = $tarball
    tarballEntries = $paths.Count
    unpackedBytes = $pack.unpackedSize
    assets = @{ fixtures = $fixturePaths.Count; python = $pythonPaths.Count; gui = $guiPaths.Count; desktop = $desktopPaths.Count; industrialProfile = $profilePaths.Count; rustEngineBundled = $engineInPackage; stagedEngineSha256 = $engineHash }
    installedPackage = $packageRoot
    cliRunId = $cliRun.runId
    cliVerdict = $cliRun.overallVerdict
    cliVerification = @{ valid = $cliVerify.verification.valid; judgedRunValid = $cliVerify.judgedRun.valid }
    rehearsals = $rehearsals | ForEach-Object { @{ scenario = $_.scenario; runId = $_.finalRunId; verdict = $_.engineeringVerdict; verification = $_.cliVerification.valid; evidence = $_.evidencePath } }
    hostedMetaCalls = 0
    submittedOrPublished = $false
    workRoot = $WorkRoot
  } | ConvertTo-Json -Depth 8
}
finally { Pop-Location }
